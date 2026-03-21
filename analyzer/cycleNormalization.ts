function stripClosingNode(cyclePath: string[]): string[] {
  if (cyclePath.length > 1 && cyclePath[0] === cyclePath.at(-1)) {
    return cyclePath.slice(0, -1);
  }

  return [...cyclePath];
}

function compareCycleSegments(left: string[], right: string[]): number {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] ?? '';
    const rightValue = right[index] ?? '';
    const comparison = leftValue.localeCompare(rightValue);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

export function canonicalizeCyclePath(cyclePath: string[]): string[] {
  const openCyclePath = stripClosingNode(cyclePath);
  if (openCyclePath.length === 0) {
    return [];
  }

  let canonicalOpenPath = openCyclePath;
  for (let startIndex = 1; startIndex < openCyclePath.length; startIndex += 1) {
    const rotatedPath = [...openCyclePath.slice(startIndex), ...openCyclePath.slice(0, startIndex)];
    if (compareCycleSegments(rotatedPath, canonicalOpenPath) < 0) {
      canonicalOpenPath = rotatedPath;
    }
  }

  return [...canonicalOpenPath, canonicalOpenPath[0]];
}

export function normalizeCyclePath(cyclePath: string[]): string {
  return canonicalizeCyclePath(cyclePath).join(' -> ');
}
