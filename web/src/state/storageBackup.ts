/** Parses a saved per-field store. If the text is unreadable it is copied to `<key>.unreadable` before the
 *  next save would overwrite it, so a bad write never silently wipes the grower's saved inputs. */
export function parseSaved(key: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      window.localStorage.setItem(`${key}.unreadable`, raw);
    } catch {
      /* nothing more to do */
    }
    return null;
  }
}
