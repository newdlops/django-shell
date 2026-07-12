// Pure semantic-token coordinate mapping from hidden Python analysis to visible overlay source.

/** Maps delta-encoded analysis tokens onto the visible user-source line range. */
export function mapOverlaySemanticTokenData(data: Uint32Array, analysisUserStartLine: number, visibleUserStartLine: number, visibleLineCount: number): Uint32Array {
  const mapped: number[] = [];
  let analysisLine = 0;
  let analysisCharacter = 0;
  let previousVisibleLine = 0;
  let previousVisibleCharacter = 0;
  let emitted = false;
  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = data[index];
    analysisLine += deltaLine;
    analysisCharacter = deltaLine === 0 ? analysisCharacter + data[index + 1] : data[index + 1];
    if (analysisLine < analysisUserStartLine) { continue; }
    const visibleLine = visibleUserStartLine + analysisLine - analysisUserStartLine;
    if (visibleLine < visibleUserStartLine || visibleLine >= visibleLineCount) { continue; }
    const visibleDeltaLine = emitted ? visibleLine - previousVisibleLine : visibleLine;
    const visibleDeltaCharacter = emitted && visibleDeltaLine === 0 ? analysisCharacter - previousVisibleCharacter : analysisCharacter;
    mapped.push(visibleDeltaLine, visibleDeltaCharacter, data[index + 2], data[index + 3], data[index + 4]);
    previousVisibleLine = visibleLine;
    previousVisibleCharacter = analysisCharacter;
    emitted = true;
  }
  return Uint32Array.from(mapped);
}
