// Plain text, case-insensitive, whole lines: a regex the model wrote, run over
// hundreds of thousands of lines on someone's server, is a risk we would wear.
export function matchesFilter(
  line: string,
  contains: string[],
  excludes: string[],
): boolean {
  const haystack = line.toLowerCase();
  const hits = (term: string): boolean => haystack.includes(term.toLowerCase());
  if (excludes.some(hits)) return false;
  return contains.length === 0 || contains.some(hits);
}
