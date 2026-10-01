// True when the string has no C0 control characters or DEL: one line, no
// terminal escapes. Used for names that end up in commit messages and the GUI.
export function isSingleLine(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}
