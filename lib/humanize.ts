// Turn a Places API category slug like "thai_restaurant" into a display label
// like "Thai Restaurant".
export function humanizeCategory(category: string): string {
  return category
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
