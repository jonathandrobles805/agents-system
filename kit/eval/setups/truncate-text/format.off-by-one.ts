export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
export function truncate(text: string, max: number): string {
  return text.length < max ? text : `${text.slice(0, max - 1)}…`;
}
