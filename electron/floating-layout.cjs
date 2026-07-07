function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function clampWindowToWorkArea(x, y, width, height, workArea, margin = 8) {
  const workLeft = workArea.x + margin;
  const workTop = workArea.y + margin;
  const workRight = workArea.x + workArea.width - margin;
  const workBottom = workArea.y + workArea.height - margin;
  const nextWidth = Math.min(width, Math.max(1, workRight - workLeft));
  const nextHeight = Math.min(height, Math.max(1, workBottom - workTop));
  return {
    x: Math.round(clamp(Number(x) || workLeft, workLeft, workRight - nextWidth)),
    y: Math.round(clamp(Number(y) || workTop, workTop, workBottom - nextHeight)),
  };
}

function getSpaces(anchorRect, workArea, gap = 8, margin = 8) {
  const workTop = workArea.y + margin;
  const workBottom = workArea.y + workArea.height - margin;
  return {
    above: Math.max(0, anchorRect.y - workTop - gap),
    below: Math.max(0, workBottom - (anchorRect.y + anchorRect.height) - gap),
  };
}

function chooseSide(anchorRect, windowHeight, workArea, gap = 8, margin = 8, preferredSide = null) {
  const spaces = getSpaces(anchorRect, workArea, gap, margin);
  if (preferredSide === 'above' && spaces.above > 0) return 'above';
  if (preferredSide === 'below' && spaces.below > 0) return 'below';
  if (spaces.below >= windowHeight) return 'below';
  if (spaces.above >= windowHeight) return 'above';
  return spaces.below >= spaces.above ? 'below' : 'above';
}

function chooseAttachedPosition(anchorRect, windowSize, workArea, options = {}) {
  const gap = Number.isFinite(Number(options.gap)) ? Number(options.gap) : 8;
  const margin = Number.isFinite(Number(options.margin)) ? Number(options.margin) : 8;
  const workLeft = workArea.x + margin;
  const workRight = workArea.x + workArea.width - margin;
  const workTop = workArea.y + margin;
  const workBottom = workArea.y + workArea.height - margin;
  const width = Math.min(windowSize.width, Math.max(1, workRight - workLeft));
  const height = Math.min(windowSize.height, Math.max(1, workBottom - workTop));
  const side = chooseSide(anchorRect, height, workArea, gap, margin, options.preferredSide || null);
  const selectionCenterX = anchorRect.x + anchorRect.width / 2;
  const x = clamp(Math.round(selectionCenterX - width / 2), workLeft, workRight - width);
  const attachedY = side === 'below'
    ? Math.round(anchorRect.y + anchorRect.height + gap)
    : Math.round(anchorRect.y - height - gap);
  const y = clamp(attachedY, workTop, workBottom - height);
  const spaces = getSpaces(anchorRect, workArea, gap, margin);
  return {
    x,
    y,
    width: windowSize.width,
    height: windowSize.height,
    side,
    spaceAbove: spaces.above,
    spaceBelow: spaces.below,
    attached: y === attachedY,
  };
}

function getSideHeightLimit(anchorRect, workArea, options = {}) {
  const gap = Number.isFinite(Number(options.gap)) ? Number(options.gap) : 8;
  const margin = Number.isFinite(Number(options.margin)) ? Number(options.margin) : 8;
  const minHeight = Number.isFinite(Number(options.minHeight)) ? Number(options.minHeight) : 1;
  const desiredHeight = Number.isFinite(Number(options.desiredHeight)) ? Number(options.desiredHeight) : minHeight;
  const side = chooseSide(anchorRect, desiredHeight, workArea, gap, margin, options.preferredSide || null);
  const spaces = getSpaces(anchorRect, workArea, gap, margin);
  return {
    side,
    limit: Math.max(minHeight, side === 'below' ? spaces.below : spaces.above),
    spaceAbove: spaces.above,
    spaceBelow: spaces.below,
  };
}

module.exports = {
  clamp,
  clampWindowToWorkArea,
  chooseAttachedPosition,
  getSideHeightLimit,
};
