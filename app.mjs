const MAX_UPLOAD_SIZE = 15 * 1024 * 1024;
const MAX_SOLUTIONS_TO_FIND = 2;
const MAX_BOARD_SIZE = 16;
const MAX_RENDER_PIXELS = 5_000_000;
const MAX_RENDER_EDGE = 2500;

export class SolveError extends Error {}

function findBands(values, threshold, minLength) {
  const result = [];
  let start = -1;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] >= threshold && start === -1) start = index;
    if (start !== -1 && (values[index] < threshold || index === values.length - 1)) {
      const end = values[index] < threshold ? index : index + 1;
      if (end - start >= minLength) result.push({ start, end });
      start = -1;
    }
  }
  return result;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function colorDistance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function isColorful(data, offset) {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const range = Math.max(red, green, blue) - Math.min(red, green, blue);
  const brightness = (red + green + blue) / 3;
  return range >= 18 && brightness >= 80 && brightness <= 245;
}

function makeColorMask(data, width, height) {
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    if (isColorful(data, index * 4)) mask[index] = 1;
  }
  return mask;
}

function findGrid(mask, width, height) {
  const x0 = Math.floor(width * 0.02);
  const x1 = Math.ceil(width * 0.98);
  const y0 = Math.floor(height * 0.28);
  const y1 = Math.ceil(height * 0.81);
  if (x1 <= x0 || y1 <= y0) throw new SolveError('图片尺寸过小，无法定位棋盘。');

  const rowCounts = new Uint32Array(y1 - y0);
  for (let y = y0; y < y1; y += 1) {
    let count = 0;
    for (let x = x0; x < x1; x += 1) count += mask[y * width + x];
    rowCounts[y - y0] = count;
  }

  const minLength = Math.max(8, Math.round(Math.min(width, height) * 0.012));
  let rows = findBands(rowCounts, (x1 - x0) * 0.32, minLength)
    .map((band) => ({ start: y0 + band.start, end: y0 + band.end }));
  if (rows.length) {
    const typicalHeight = median(rows.map((band) => band.end - band.start));
    rows = rows.filter((band) => band.end - band.start >= typicalHeight * 0.7);
  }
  if (rows.length < 4 || rows.length > MAX_BOARD_SIZE) {
    throw new SolveError(`未识别出连续棋盘行（识别到 ${rows.length} 行）。请上传包含完整棋盘、未裁切的游戏截图。`);
  }

  const top = rows[0].start;
  const bottom = rows.at(-1).end;
  const columnCounts = new Uint32Array(x1 - x0);
  for (let x = x0; x < x1; x += 1) {
    let count = 0;
    for (let y = top; y < bottom; y += 1) count += mask[y * width + x];
    columnCounts[x - x0] = count;
  }
  const columns = findBands(columnCounts, (bottom - top) * 0.42, minLength)
    .map((band) => ({ start: x0 + band.start, end: x0 + band.end }));
  if (rows.length !== columns.length) {
    throw new SolveError(`棋盘行列数不一致（识别到 ${rows.length} 行、${columns.length} 列）。请避免遮挡棋盘，并保证截图中包含完整棋盘。`);
  }
  return { rows, columns };
}

function dominantCellColor(data, width, row, column) {
  const height = row.end - row.start;
  const cellWidth = column.end - column.start;
  const innerMargin = Math.max(3, Math.floor(Math.min(height, cellWidth) * 0.08));
  const borderWidth = Math.max(4, Math.floor(Math.min(height, cellWidth) * 0.14));
  if (height <= innerMargin * 2 || cellWidth <= innerMargin * 2) throw new SolveError('棋盘格尺寸异常。');

  const buckets = new Map();
  let usableCount = 0;
  // 从格子边缘的彩色边框取主色，避开中央已放小牛、叉号等覆盖图标。
  for (let y = row.start + innerMargin; y < row.end - innerMargin; y += 1) {
    for (let x = column.start + innerMargin; x < column.end - innerMargin; x += 1) {
      const edgeDistance = Math.min(y - row.start, row.end - y - 1, x - column.start, column.end - x - 1);
      if (edgeDistance > borderWidth) continue;
      const offset = (y * width + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const range = Math.max(red, green, blue) - Math.min(red, green, blue);
      if (range < 18 || (red + green + blue) / 3 >= 245) continue;
      usableCount += 1;
      const key = `${Math.floor(red / 12)},${Math.floor(green / 12)},${Math.floor(blue / 12)}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }
  if (usableCount < 20) throw new SolveError('有格子未能读取颜色，请使用未被弹窗遮挡的截图。');

  const [bestKey] = [...buckets.entries()].reduce((best, entry) => entry[1] > best[1] ? entry : best);
  const [bucketRed, bucketGreen, bucketBlue] = bestKey.split(',').map(Number);
  const reds = [];
  const greens = [];
  const blues = [];
  for (let y = row.start + innerMargin; y < row.end - innerMargin; y += 1) {
    for (let x = column.start + innerMargin; x < column.end - innerMargin; x += 1) {
      const edgeDistance = Math.min(y - row.start, row.end - y - 1, x - column.start, column.end - x - 1);
      if (edgeDistance > borderWidth) continue;
      const offset = (y * width + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (Math.floor(red / 12) === bucketRed && Math.floor(green / 12) === bucketGreen && Math.floor(blue / 12) === bucketBlue) {
        reds.push(red);
        greens.push(green);
        blues.push(blue);
      }
    }
  }
  return [median(reds), median(greens), median(blues)];
}

function isPlacedCow(data, width, row, column, background) {
  const insetY = Math.max(3, Math.floor((row.end - row.start) / 5));
  const insetX = Math.max(3, Math.floor((column.end - column.start) / 5));
  let changedPixels = 0;
  let orangeCrossPixels = 0;
  let totalPixels = 0;
  for (let y = row.start + insetY; y < row.end - insetY; y += 1) {
    for (let x = column.start + insetX; x < column.end - insetX; x += 1) {
      const offset = (y * width + x) * 4;
      const difference = Math.hypot(data[offset] - background[0], data[offset + 1] - background[1], data[offset + 2] - background[2]);
      if (difference > 65) {
        changedPixels += 1;
        const red = data[offset];
        const green = data[offset + 1];
        const blue = data[offset + 2];
        if (red > green + 35 && green > blue + 20 && red > 140) orangeCrossPixels += 1;
      }
      totalPixels += 1;
    }
  }
  // 小牛图标会覆盖格子中心，且包含眼睛、轮廓等多种明暗颜色；错误 X 几乎是单一橙红色。
  return totalPixels > 0 && changedPixels / totalPixels >= 0.28 && orangeCrossPixels / changedPixels < 0.85;
}

function findPlacedCows(data, width, rows, columns, samples, labels) {
  const placements = [];
  rows.forEach((row, rowIndex) => columns.forEach((column, columnIndex) => {
    const sampleIndex = rowIndex * columns.length + columnIndex;
    if (isPlacedCow(data, width, row, column, samples[sampleIndex])) {
      placements.push({ row: rowIndex, column: columnIndex, color: labels[sampleIndex] });
    }
  }));
  return placements;
}

function clusterColors(samples, size) {
  const representatives = [];
  const labels = [];
  for (const sample of samples) {
    const distances = representatives.map((representative) => colorDistance(sample, representative));
    const nearest = distances.length ? Math.min(...distances) : Infinity;
    if (nearest <= 38) labels.push(distances.indexOf(nearest));
    else {
      labels.push(representatives.length);
      representatives.push(sample);
    }
  }
  for (let index = 0; index < representatives.length; index += 1) {
    const members = samples.filter((_, sampleIndex) => labels[sampleIndex] === index);
    representatives[index] = [
      median(members.map((sample) => sample[0])),
      median(members.map((sample) => sample[1])),
      median(members.map((sample) => sample[2])),
    ];
  }
  if (representatives.length !== size) {
    throw new SolveError(`识别到 ${size}×${size} 棋盘，但得到 ${representatives.length} 种颜色。请使用原始截图，且不要开启色盲模式、护眼滤镜或全局调色。`);
  }
  return { labels, representatives };
}

function rowCandidates(colorGrid, row, cowsPerGroup) {
  const size = colorGrid.length;
  const candidates = [];
  function choose(start, columns) {
    if (columns.length === cowsPerGroup) {
      const placements = columns.map((column) => ({ row, column, color: colorGrid[row][column] }));
      const colorCounts = new Map();
      placements.forEach((placement) => colorCounts.set(placement.color, (colorCounts.get(placement.color) ?? 0) + 1));
      candidates.push({ columns, placements, colorCounts });
      return;
    }
    for (let column = start; column < size; column += 1) {
      if (columns.some((chosen) => Math.abs(chosen - column) <= 1)) continue;
      choose(column + 1, [...columns, column]);
    }
  }
  choose(0, []);
  return candidates;
}

export function solveColorGrid(colorGrid, cowsPerGroup = 1, fixedPlacements = []) {
  const size = colorGrid.length;
  if (!Number.isInteger(cowsPerGroup) || ![1, 2].includes(cowsPerGroup)) {
    throw new SolveError('请选择单牛或双牛模式。');
  }
  if (cowsPerGroup * 2 > size + 1) {
    throw new SolveError(`${size}×${size} 棋盘无法满足每行放 ${cowsPerGroup} 头且小牛不相邻的规则。`);
  }

  const fixedByRow = Array.from({ length: size }, () => []);
  const fixedKeys = new Set();
  for (const placement of fixedPlacements) {
    if (!Number.isInteger(placement.row) || !Number.isInteger(placement.column)
      || placement.row < 0 || placement.row >= size || placement.column < 0 || placement.column >= size) {
      throw new SolveError('已放小牛的位置超出棋盘范围。');
    }
    const key = `${placement.row},${placement.column}`;
    if (fixedKeys.has(key)) continue;
    if (colorGrid[placement.row][placement.column] !== placement.color) {
      throw new SolveError('已放小牛的颜色与棋盘识别结果不一致。');
    }
    fixedKeys.add(key);
    fixedByRow[placement.row].push(placement);
  }
  for (const placements of fixedByRow) {
    if (placements.length > cowsPerGroup) throw new SolveError('同一行已放的小牛数量超过当前模式要求。');
  }
  for (let left = 0; left < fixedPlacements.length; left += 1) {
    for (let right = left + 1; right < fixedPlacements.length; right += 1) {
      const a = fixedPlacements[left];
      const b = fixedPlacements[right];
      if (Math.abs(a.row - b.row) <= 1 && Math.abs(a.column - b.column) <= 1) {
        throw new SolveError('已放小牛之间存在相邻位置，请先在游戏中撤销冲突的小牛。');
      }
    }
  }

  const candidatesByRow = colorGrid.map((_, row) => rowCandidates(colorGrid, row, cowsPerGroup)
    .filter((candidate) => fixedByRow[row].every((placement) => candidate.columns.includes(placement.column))));
  const suffixColorCells = Array.from({ length: size + 1 }, () => new Array(size).fill(0));
  for (let row = size - 1; row >= 0; row -= 1) {
    suffixColorCells[row] = [...suffixColorCells[row + 1]];
    colorGrid[row].forEach((color) => suffixColorCells[row][color] += 1);
  }

  const answers = [];
  const columnCounts = new Array(size).fill(0);
  const colorCounts = new Array(size).fill(0);
  const answer = [];
  function canStillComplete(row) {
    const remainingRows = size - row - 1;
    if (columnCounts.some((count) => count > cowsPerGroup || count + remainingRows < cowsPerGroup)) return false;
    return colorCounts.every((count, color) => count <= cowsPerGroup && count + suffixColorCells[row + 1][color] >= cowsPerGroup);
  }
  function search(row) {
    if (answers.length >= MAX_SOLUTIONS_TO_FIND) return;
    if (row === size) {
      if (columnCounts.every((count) => count === cowsPerGroup) && colorCounts.every((count) => count === cowsPerGroup)) {
        answers.push(answer.map((placement) => ({ ...placement })));
      }
      return;
    }
    const previousRow = answer.filter((placement) => placement.row === row - 1);
    for (const candidate of candidatesByRow[row]) {
      if (candidate.columns.some((column) => columnCounts[column] >= cowsPerGroup)) continue;
      if ([...candidate.colorCounts].some(([color, count]) => colorCounts[color] + count > cowsPerGroup)) continue;
      if (previousRow.length && candidate.columns.some((column) => previousRow.some((placement) => Math.abs(column - placement.column) <= 1))) continue;

      candidate.columns.forEach((column) => columnCounts[column] += 1);
      candidate.colorCounts.forEach((count, color) => colorCounts[color] += count);
      answer.push(...candidate.placements);
      if (canStillComplete(row)) search(row + 1);
      answer.splice(-candidate.placements.length);
      candidate.colorCounts.forEach((count, color) => colorCounts[color] -= count);
      candidate.columns.forEach((column) => columnCounts[column] -= 1);
    }
  }
  search(0);
  return answers;
}

export function solvePixels(data, width, height, { cowsPerGroup = 1 } = {}) {
  const mask = makeColorMask(data, width, height);
  const { rows, columns } = findGrid(mask, width, height);
  const size = rows.length;
  const samples = rows.flatMap((row) => columns.map((column) => dominantCellColor(data, width, row, column)));
  const { labels, representatives } = clusterColors(samples, size);
  const colorGrid = Array.from({ length: size }, (_, row) => labels.slice(row * size, (row + 1) * size));
  const fixedPlacements = findPlacedCows(data, width, rows, columns, samples, labels);
  const answers = solveColorGrid(colorGrid, cowsPerGroup, fixedPlacements);
  if (!answers.length) {
    const prefix = fixedPlacements.length ? `已识别出 ${fixedPlacements.length} 头已放小牛，但` : '';
    throw new SolveError(`${prefix}按${cowsPerGroup === 2 ? '双牛' : '单牛'}规则无法找到符合条件的摆放。请确认模式和截图内容是否一致，或上传未操作过的原始关卡截图。`);
  }
  return { rows, columns, representatives, answer: answers[0], solutionCount: answers.length, cowsPerGroup, fixedPlacements };
}

function colorToHex(color) {
  return `#${color.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function buildStrategy(solution) {
  const size = solution.rows.length;
  const cowsPerGroup = solution.cowsPerGroup ?? 1;
  const fixedKeys = new Set((solution.fixedPlacements ?? []).map((placement) => `${placement.row},${placement.column}`));
  const steps = solution.answer.flatMap((placement, index) => {
    const color = colorToHex(solution.representatives[placement.color]);
    const sameRow = solution.answer.slice(0, index).filter((cell) => cell.row === placement.row);
    const previousRow = solution.answer.filter((cell) => cell.row === placement.row - 1);
    const base = cowsPerGroup === 1
      ? `选择这格后，第 ${placement.column + 1} 列和这种颜色都会被本条路线使用一次。`
      : `选择这格后，它会补足本条路线在第 ${placement.column + 1} 列和这种颜色上的 1 个名额，整关各需要 ${cowsPerGroup} 个名额。`;
    const spacing = [];
    if (sameRow.length) {
      const gap = Math.min(...sameRow.map((cell) => Math.abs(placement.column - cell.column)));
      spacing.push(`与同一行另一头小牛相隔 ${gap} 列，不会横向相邻。`);
    }
    if (previousRow.length) {
      const gap = Math.min(...previousRow.map((cell) => Math.abs(placement.column - cell.column)));
      spacing.push(`与上一行的落点最近相隔 ${gap} 列，避开了竖向和斜向相邻。`);
    }
    if (!spacing.length) spacing.push('先从第一行的这格开始，为后续各行保留符合条件的列和颜色。');
    const step = { color, title: `第 ${placement.row + 1} 行，第 ${placement.column + 1} 列`, description: `${base}${spacing.join('')}` };
    return fixedKeys.has(`${placement.row},${placement.column}`) ? [] : [step];
  });
  return {
    intro: `${solution.fixedPlacements?.length ? `已识别并保留 ${solution.fixedPlacements.length} 头已放小牛；` : ''}红圈中的 ${solution.answer.length - fixedKeys.size} 个格子是还需要补上的${cowsPerGroup === 2 ? '双牛' : '单牛'}答案：每一行、每一列和每一种颜色都恰好有 ${cowsPerGroup} 头小牛；横向、竖向和斜向相邻的格子不会同时放牛。`,
    note: solution.solutionCount === 1
      ? '本关解唯一，按红圈顺序或任意顺序点击这些格子都可以。'
      : '本关存在多个可行解；红圈和下列步骤展示的是其中一条可直接照着点击的路线。',
    steps,
  };
}

function drawSolution(canvas, solution) {
  const context = canvas.getContext('2d');
  context.save();
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const fixedKeys = new Set((solution.fixedPlacements ?? []).map((placement) => `${placement.row},${placement.column}`));
  let sequence = 0;
  solution.answer.forEach((placement) => {
    if (fixedKeys.has(`${placement.row},${placement.column}`)) return;
    sequence += 1;
    const row = solution.rows[placement.row];
    const column = solution.columns[placement.column];
    const x = (column.start + column.end) / 2;
    const y = (row.start + row.end) / 2;
    const radius = Math.max(15, Math.min(column.end - column.start, row.end - row.start) / 3);
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = '#e23340';
    context.fill();
    context.lineWidth = 4;
    context.strokeStyle = '#fff';
    context.stroke();
    context.fillStyle = '#fff';
    context.font = `700 ${Math.max(14, Math.round(radius * 1.05))}px sans-serif`;
    context.fillText(String(sequence), x, y + 1);
  });
  context.restore();
}

async function canvasFromFile(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(file);
  }
  const scale = Math.min(1, MAX_RENDER_EDGE / Math.max(bitmap.width, bitmap.height), Math.sqrt(MAX_RENDER_PIXELS / (bitmap.width * bitmap.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

if (typeof document !== 'undefined') {
  const input = document.querySelector('#fileInput');
  const dropZone = document.querySelector('#dropZone');
  const status = document.querySelector('#status');
  const result = document.querySelector('#result');
  const answerImage = document.querySelector('#answerImage');
  const answerList = document.querySelector('#answerList');
  const meta = document.querySelector('#meta');
  const strategyPanel = document.querySelector('#strategyPanel');
  const strategyIntro = document.querySelector('#strategyIntro');
  const strategyList = document.querySelector('#strategyList');
  const strategyNote = document.querySelector('#strategyNote');
  const modeInputs = document.querySelectorAll('input[name="cowMode"]');

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  async function solve(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setStatus('请选择 PNG、JPG 或 WebP 图片。', true);
      return;
    }
    if (file.size > MAX_UPLOAD_SIZE) {
      setStatus('图片超过 15 MB，请换一张较小的截图。', true);
      return;
    }
    const cowsPerGroup = Number([...modeInputs].find((candidate) => candidate.checked)?.value ?? 1);
    setStatus(`正在按${cowsPerGroup === 2 ? '双牛' : '单牛'}模式识别棋盘并求解…`);
    result.style.display = 'none';
    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const canvas = await canvasFromFile(file);
      const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
      const solution = solvePixels(pixels, canvas.width, canvas.height, { cowsPerGroup });
      drawSolution(canvas, solution);
      answerImage.src = canvas.toDataURL('image/png');
      const fixedKeys = new Set(solution.fixedPlacements.map((placement) => `${placement.row},${placement.column}`));
      const remainingCells = solution.answer.filter((cell) => !fixedKeys.has(`${cell.row},${cell.column}`));
      answerList.replaceChildren(...remainingCells.map((cell, index) => {
        const item = document.createElement('div');
        const color = colorToHex(solution.representatives[cell.color]);
        item.className = 'cell';
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = color;
        item.append(dot, `${index + 1}. 第 ${cell.row + 1} 行，第 ${cell.column + 1} 列`);
        return item;
      }));
      const strategy = buildStrategy(solution);
      strategyIntro.textContent = strategy.intro;
      strategyList.replaceChildren(...strategy.steps.map((step) => {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        const color = document.createElement('span');
        color.className = 'dot';
        color.style.background = step.color;
        title.append(color, step.title);
        const description = document.createElement('span');
        description.textContent = step.description;
        item.append(title, description);
        return item;
      }));
      strategyNote.textContent = strategy.note;
      strategyPanel.hidden = false;
      const size = solution.rows.length;
      const mode = solution.cowsPerGroup === 2 ? '双牛' : '单牛';
      const resultSummary = solution.solutionCount === 1 ? '解唯一。' : '存在多个可行解，以下为其中一个。';
      meta.textContent = `识别为 ${size}×${size} ${mode}棋盘，${resultSummary}${solution.fixedPlacements.length ? ` 已识别 ${solution.fixedPlacements.length} 头已经放置的小牛，下面列出还需补的 ${remainingCells.length} 头。` : ''}`;
      result.style.display = 'block';
      requestAnimationFrame(() => result.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
      setStatus('求解完成。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '处理图片时发生未预期错误。', true);
    } finally {
      input.value = '';
    }
  }

  input.addEventListener('change', () => solve(input.files[0]));
  ['dragenter', 'dragover'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  }));
  dropZone.addEventListener('drop', (event) => solve([...event.dataTransfer.files].find((file) => file.type.startsWith('image/'))));
  document.addEventListener('paste', (event) => {
    const file = [...event.clipboardData?.files ?? []].find((candidate) => candidate.type.startsWith('image/'))
      ?? [...event.clipboardData?.items ?? []].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).find(Boolean);
    if (!file) return;
    event.preventDefault();
    solve(file);
  });
}
