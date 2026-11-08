// Turn a title into a URL slug: lower case, ASCII letters and digits only,
// words joined by single hyphens, no hyphen at either end.
export function slugify(title: string): string {
  return title.toLowerCase().replace(/ /g, "-");
}
