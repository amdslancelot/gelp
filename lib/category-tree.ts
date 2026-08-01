// A two-tier reading of Google's category vocabulary.
//
// Google hands out one flat label per place — `izakaya_restaurant`,
// `udon_noodle_restaurant`, `teppanyaki_restaurant` — with no statement that
// the three are the same kind of dinner. Across this repo's places that flat
// list runs to 355 distinct labels, which is not a filter anyone can use.
//
// So each label gets a parent: the umbrella it belongs under. The parent is
// itself a category name wherever the vocabulary already has one that fits
// (`japanese_restaurant` is both a label in its own right and the umbrella
// over the three above), and a coined one where it does not — Google has no
// word for "this is transport" or "this is a school".
//
// The grouping below is a judgement call made once, by hand, over the whole
// vocabulary. It is data, not inference: nothing here is derived at runtime,
// so a wrong grouping is a one-line edit rather than a tuning problem. Where a
// place could sit under two umbrellas the tie went to what the place is *for* —
// a hot spring is somewhere you go, so it is a natural feature, not a spa.
//
// `scripts/selfcheck.ts` asserts every category in the database is named here.
// A new one Google invents falls back to a suffix rule and is still browsable,
// but it is meant to be caught and placed deliberately.

/** Every category under an umbrella. The key is the umbrella, and is itself a valid tier 1. */
export const CATEGORY_TREE: Record<string, readonly string[]> = {
  // --- eating ------------------------------------------------------------
  japanese_restaurant: [
    "sushi_restaurant",
    "ramen_restaurant",
    "japanese_izakaya_restaurant",
    "izakaya_restaurant",
    "yakiniku_restaurant",
    "yakitori_restaurant",
    "japanese_curry_restaurant",
    "udon_noodle_restaurant",
    "teppanyaki_restaurant",
    "unagi_restaurant",
    "tonkatsu_restaurant",
    "takoyaki_restaurant",
    "syokudo_and_teishoku_restaurant",
    "japanese_sweets_restaurant",
    "japanized_western_restaurant",
  ],
  // Kept apart from chinese_restaurant deliberately: 50 places, and the two
  // cuisines are not read as one by anyone who eats them.
  taiwanese_restaurant: [],
  chinese_restaurant: [
    "cantonese_restaurant",
    "sichuan_restaurant",
    "dim_sum_restaurant",
    "hot_pot_restaurant",
    "dumpling_restaurant",
    "chinese_noodle_restaurant",
  ],
  korean_restaurant: ["korean_barbecue_restaurant"],
  asian_restaurant: [
    "asian_fusion_restaurant",
    "thai_restaurant",
    "vietnamese_restaurant",
    "filipino_restaurant",
    "malaysian_restaurant",
    "cambodian_restaurant",
    "burmese_restaurant",
  ],
  indian_restaurant: [
    "south_indian_restaurant",
    "modern_indian_restaurant",
    "pakistani_restaurant",
    "nepalese_restaurant",
    "sri_lankan_restaurant",
    "tibetan_restaurant",
  ],
  italian_restaurant: [
    "northern_italian_restaurant",
    "pizza_restaurant",
    "pizza_delivery",
  ],
  french_restaurant: [],
  european_restaurant: [
    "german_restaurant",
    "austrian_restaurant",
    "dutch_restaurant",
    "czech_restaurant",
    "scandinavian_restaurant",
    "eastern_european_restaurant",
    "western_restaurant",
  ],
  mediterranean_restaurant: [
    "greek_restaurant",
    "spanish_restaurant",
    "tapas_restaurant",
    "basque_restaurant",
    "portuguese_restaurant",
  ],
  middle_eastern_restaurant: [
    "turkish_restaurant",
    "persian_restaurant",
    "moroccan_restaurant",
    "afghan_restaurant",
    "halal_restaurant",
    "kebab_shop",
  ],
  african_restaurant: ["ethiopian_restaurant"],
  american_restaurant: [
    "new_american_restaurant",
    "californian_restaurant",
    "southwestern_us_restaurant",
    "hawaiian_restaurant",
    "cajun_restaurant",
    "soul_food_restaurant",
    "barbecue_restaurant",
    "steak_house",
    "hamburger_restaurant",
    "hot_dog_restaurant",
    "chicken_restaurant",
    "chicken_wings_restaurant",
    "fast_food_restaurant",
    "sandwich_shop",
    "deli",
    "diner",
  ],
  mexican_restaurant: ["taco_restaurant"],
  latin_american_restaurant: [
    "peruvian_restaurant",
    "colombian_restaurant",
    "cuban_restaurant",
    "puerto_rican_restaurant",
    "caribbean_restaurant",
  ],
  seafood_restaurant: ["oyster_bar_restaurant", "fish_and_chips_restaurant"],
  vegetarian_restaurant: ["vegan_restaurant"],
  // Everything that is a meal but declares no cuisine.
  restaurant: [
    "fine_dining_restaurant",
    "family_restaurant",
    "buffet_restaurant",
    "breakfast_restaurant",
    "brunch_restaurant",
    "bistro",
    "noodle_shop",
    "food_court",
    "cafeteria",
    "meal_takeaway",
    "catering_service",
    "caterer",
    "food",
  ],

  // --- drinking ----------------------------------------------------------
  cafe: [
    "coffee_shop",
    "coffee_roastery",
    "coffee_store",
    "tea_house",
    "bubble_tea_store",
    "juice_shop",
  ],
  bakery: [
    "pastry_shop",
    "cake_shop",
    "confectionery",
    "dessert_shop",
    "dessert_restaurant",
    "ice_cream_shop",
    "donut_shop",
    "chocolate_shop",
    "bagel_shop",
  ],
  bar: [
    "cocktail_bar",
    "wine_bar",
    "sports_bar",
    "lounge_bar",
    "bar_and_grill",
    "pub",
    "gastropub",
    "brewery",
    "brewpub",
    "winery",
    "vineyard",
    "night_club",
    "karaoke_bar",
    "adult_entertainment_club",
  ],

  // --- staying -----------------------------------------------------------
  hotel: [
    "resort_hotel",
    "motel",
    "hostel",
    "lodging",
    "inn",
    "bed_and_breakfast",
    "japanese_inn",
    "farmstay",
    "private_guest_room",
  ],

  // --- outdoors ----------------------------------------------------------
  park: [
    "national_park",
    "state_park",
    "city_park",
    "dog_park",
    "garden",
    "botanical_garden",
    "nature_preserve",
    "wildlife_refuge",
    "picnic_ground",
    "playground",
    "campground",
    "rv_park",
  ],
  natural_feature: [
    "hiking_area",
    "scenic_spot",
    "vista_point",
    "lake",
    "river",
    "beach",
    "island",
    "peninsula",
    "mountain_peak",
    "mountain_range",
    "volcano",
    "woods",
    "spring",
    "hot_spring",
    "reservoir",
  ],

  // --- looking at things -------------------------------------------------
  museum: ["art_museum", "history_museum", "war_museum"],
  art_gallery: ["art_studio"],
  landmark: [
    "historical_landmark",
    "cultural_landmark",
    "historical_place",
    "heritage_preservation",
    "historical_market_square",
    "monument",
    "sculpture",
    "castle",
    "bridge",
    "fountain",
    "observation_deck",
  ],
  place_of_worship: [
    "church",
    "methodist_church",
    "anglican_church",
    "shinto_shrine",
    "buddhist_temple",
    "hindu_temple",
    "taoist_temple",
    "mosque",
  ],
  tourist_attraction: [
    "theme_park",
    "amusement_center",
    "zoo",
    "visitor_center",
    "tourist_information_center",
    "movie_theater",
    "concert_hall",
    "performing_arts_theater",
    "live_music_venue",
    "dinner_theater",
    "arena",
    "event_venue",
    "banquet_hall",
    "wedding_venue",
    "farm",
    "ranch",
  ],

  // --- buying things -----------------------------------------------------
  clothing_store: [
    "used_clothing_store",
    "vintage_clothing_store",
    "mens_clothing_store",
    "womens_clothing_store",
    "sportswear_store",
    "outdoor_clothing_and_equipment_shop",
    "work_clothes_store",
    "boutique",
    "consignment_shop",
    "clothing_supplier",
    "clothing_wholesaler",
    "shoe_store",
    "fashion_accessories_store",
    "jewelry_store",
    "tailor",
  ],
  store: [
    "general_store",
    "gift_shop",
    "souvenir_store",
    "department_store",
    "shopping_mall",
    "thrift_store",
    "second_hand_store",
    "discount_store",
    "book_store",
    "toy_store",
    "furniture_store",
    "home_goods_store",
    "home_improvement_store",
    "building_materials_store",
    "garden_center",
    "florist",
    "electronics_store",
    "sporting_goods_store",
    "art_supply_store",
    "used_musical_instrument_store",
    "native_american_goods_store",
    "mexican_goods_store",
    "liquor_store",
    "tea_store",
    "cannabis_store",
    "auto_parts_store",
  ],
  grocery_store: [
    "supermarket",
    "hypermarket",
    "convenience_store",
    "asian_grocery_store",
    "food_store",
    "butcher_shop",
  ],
  market: ["night_market", "farmers_market", "flea_market", "clothes_market"],

  // --- doing things ------------------------------------------------------
  sports: [
    "sports_activity_location",
    "sports_club",
    "sports_complex",
    "sports_coaching",
    "athletic_field",
    "gym",
    "fitness_center",
    "swimming_pool",
    "basketball_court",
    "tennis_court",
    "golf_course",
    "golf_club",
    "miniature_golf_course",
    "race_course",
  ],
  health: [
    "medical_clinic",
    "doctor",
    "chiropractor",
    "spa",
    "wellness_center",
    "public_bath",
  ],
  education: [
    "educational_institution",
    "university",
    "elementary_school",
    "primary_school",
    "preschool",
    "library",
    "research_institute",
  ],

  // --- getting there -----------------------------------------------------
  transport: [
    "train_station",
    "transit_station",
    "bus_stop",
    "tram_stop",
    "ferry_terminal",
    "heliport",
    "marina",
    "mountain_cable_car",
    "parking",
    "parking_lot",
    "gas_station",
    "rest_stop",
    "car_rental",
    "transportation_service",
  ],

  // --- everything else ---------------------------------------------------
  service: [
    "car_repair",
    "car_wash",
    "car_dealer",
    "used_car_dealer",
    "laundry",
    "barber_shop",
    "travel_agency",
    "tour_agency",
  ],
  business: [
    "corporate_office",
    "business_center",
    "coworking_space",
    "manufacturer",
    "wholesaler",
    "general_contractor",
    "consultant",
    "interior_designer",
    "employment_agency",
    "television_studio",
    "bank",
    "finance",
  ],
  civic: [
    "government_office",
    "non_profit_organization",
    "association_or_organization",
    "association_organization",
    "community_center",
    "cultural_center",
  ],
  residential: ["apartment_building", "condominium_complex"],
  // Google's own "we could not say" labels. Kept rather than hidden, because a
  // saved place with no useful category is still a saved place.
  other: ["point_of_interest", "premise", "intersection"],
};

/** Tier-1 names, in the order a filter should offer them. */
export const TIER1 = Object.keys(CATEGORY_TREE);

const PARENT: ReadonlyMap<string, string> = new Map(
  Object.entries(CATEGORY_TREE).flatMap(([parent, children]) => [
    [parent, parent] as [string, string],
    ...children.map((child) => [child, parent] as [string, string]),
  ]),
);

// Only reached by a category invented after this table was written. Guessing
// from the suffix keeps it browsable; selfcheck is what stops it staying a
// guess.
const SUFFIX_RULES: ReadonlyArray<readonly [string, string]> = [
  ["_restaurant", "restaurant"],
  ["_cafe", "cafe"],
  ["_bar", "bar"],
  ["_bakery", "bakery"],
  ["_hotel", "hotel"],
  ["_museum", "museum"],
  ["_park", "park"],
  ["_temple", "place_of_worship"],
  ["_shrine", "place_of_worship"],
  ["_church", "place_of_worship"],
  ["_school", "education"],
  ["_station", "transport"],
  ["_stop", "transport"],
  ["_market", "market"],
  ["_store", "store"],
  ["_shop", "store"],
];

/** The umbrella a category belongs under. Falls back to a suffix rule, then "other". */
export function tier1Of(category: string): string {
  const known = PARENT.get(category);
  if (known) return known;
  for (const [suffix, parent] of SUFFIX_RULES) {
    if (category.endsWith(suffix)) return parent;
  }
  return "other";
}

/** True when the category was placed by hand rather than guessed at. */
export function isPlaced(category: string): boolean {
  return PARENT.has(category);
}
