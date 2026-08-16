// Turn a Places API category slug like "thai_restaurant" into a display label
// like "Thai Restaurant".
export function humanizeCategory(category: string): string {
  return category
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// The group chips are the one row a user reads without thinking, so they get
// written labels rather than slugs run through the humaniser: "Food And Drink"
// and "Staying" are what the slug says, not what a person would.
const GROUP_LABELS: Record<string, string> = {
  food_and_drink: "Food & Drink",
  shopping: "Shopping",
  outdoors: "Outdoors",
  culture: "Culture",
  staying: "Stay",
  services: "Services",
};

export function humanizeGroup(group: string): string {
  return GROUP_LABELS[group] ?? humanizeCategory(group);
}

// Present a list's stored name for display. Takeout labels the starred-places
// list "Saved Places"; Google Maps itself now calls it "Starred places", so we
// match that. The stored name is left untouched so re-imports still match by it.
export function displayListName(name: string): string {
  if (name === "Saved Places") return "Starred places";
  return name;
}
