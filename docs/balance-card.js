/* Render a balance snapshot, never live app state. No network or storage. */
'use strict';

window.BahiBalanceCard = (() => {
  const WIDTH = 1080, HEIGHT = 710;
  const FONT = 'Roboto, system-ui, -apple-system, "Segoe UI", sans-serif';
  const COLORS = { paper: '#ffffff', brand: '#1565c0', due: '#d93025',
    credit: '#188038', text: '#202124', muted: '#5f6368', rule: '#e5e7eb' };

  function font(ctx, size, weight) { ctx.font = `${weight} ${size}px ${FONT}`; }
  function linesFor(ctx, value, width) {
    const words = value.trim().split(/\s+/u);
    const lines = [];
    let line = '';
    const segments = typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
    for (const word of words) {
      if (ctx.measureText(word).width > width) {
        if (line) { lines.push(line); line = ''; }
        const chars = segments ? [...segments.segment(word)].map(p => p.segment) : [...word];
        for (const ch of chars) {
          if (line && ctx.measureText(line + ch).width > width) { lines.push(line); line = ''; }
          line += ch;
        }
      } else if (line && ctx.measureText(line + ' ' + word).width > width) {
        lines.push(line); line = word;
      } else line += (line ? ' ' : '') + word;
      if (lines.length > 2) return lines; // this size cannot fit
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawName(ctx, value, x, width, singleY, firstY, color, weight) {
    for (let size = 52; size >= 40; size -= 2) {
      font(ctx, size, weight);
      const lines = linesFor(ctx, value, width);
      if (lines.length > 2 || lines.some(line => ctx.measureText(line).width > width)) continue;
      ctx.fillStyle = color; ctx.textAlign = 'left';
      lines.forEach((line, i) => ctx.fillText(line, x, lines.length === 1 ? singleY : firstY + i * 54));
      return;
    }
    throw new Error('Name is too long for the image. Use Text only or Copy message.');
  }

  async function render(snapshot) {
    const s = { ...snapshot }; // caller may discard its session while fonts load
    for (const key of ['merchantName', 'customerName', 'amountText', 'asOfDate']) {
      if (typeof s[key] !== 'string' || !s[key].trim() || s[key].length > 2000) {
        throw new Error('Balance details cannot fit in an image. Use Text only or Copy message.');
      }
    }
    if (!['due', 'credit'].includes(s.direction)) throw new Error('Invalid balance direction.');
    if (document.fonts?.ready) await document.fonts.ready;
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image creation is unavailable. Use Text only or Copy message.');
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.paper; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = COLORS.brand; ctx.fillRect(0, 0, WIDTH, 136);
    drawName(ctx, s.merchantName, 64, 765, 87, 58, COLORS.paper, 700);
    ctx.fillStyle = COLORS.paper; ctx.textAlign = 'right'; font(ctx, 40, 700);
    ctx.fillText('Bahi', 1016, 87);
    drawName(ctx, s.customerName, 64, 952, 235, 211, COLORS.text, 500);
    const color = COLORS[s.direction];
    ctx.fillStyle = color; ctx.textAlign = 'center'; font(ctx, 48, 500);
    ctx.fillText(s.direction === 'due' ? 'Aapka baki' : 'Aapko milenge', 540, 340);
    let size = 182;
    for (; size >= 72; size -= 2) {
      font(ctx, size, 900);
      if (ctx.measureText(s.amountText).width <= 920) break;
    }
    if (size < 72) throw new Error('Amount is too long for the image. Use Text only or Copy message.');
    ctx.fillText(s.amountText, 540, 510);
    ctx.fillStyle = COLORS.rule; ctx.fillRect(72, 577, 936, 2);
    ctx.fillStyle = COLORS.muted; font(ctx, 40, 400);
    const date = s.asOfDate + ' ka hisaab';
    if (ctx.measureText(date).width > 936) throw new Error('Date cannot fit in the image.');
    ctx.fillText(date, 540, 645);
    ctx.fillStyle = COLORS.brand; ctx.fillRect(0, 700, WIDTH, 10);
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Could not create the image. Use Text only or Copy message.'));
    }, 'image/png'));
  }
  return Object.freeze({ render });
})();
