/*
  Credits and disclosures (card 6.5). Keep this list in step with the NASA Space Apps
  project page's References field. Library versions and licenses were read from each
  package's own package.json on Nov 12, 2026.
*/

export const DATA_CREDITS = [
  {
    name: "NASA POWER Daily API (Prediction Of Worldwide Energy Resources)",
    owner: "NASA Langley Research Center",
    url: "https://power.larc.nasa.gov/",
    used: "Daily records for a reference point in each of eight NC counties (the sample is near Monroe, Union County), 1981–2025: corrected precipitation (PRECTOTCORR), surface and root-zone soil wetness (GWETTOP, GWETROOT) and air temperature (T2M, T2M_MAX, T2M_MIN), all from NASA's MERRA-2 reanalysis. The screens show the rain and the root-zone wetness; the other variables are stored with each day.",
    note: "These data were obtained from the NASA Langley Research Center (LaRC) POWER Project funded through the NASA Earth Science/Applied Science Program.",
  },
  {
    name: "GPM IMERG satellite rain, through NASA POWER",
    owner: "NASA Goddard Space Flight Center and NASA Langley Research Center",
    url: "https://gpm.nasa.gov/data/imerg",
    used: "Yearly rain on squares about 10 km across, shown beside the 50 km record on the results. It changes no result.",
  },
  {
    name: "NASA GIBS map pictures: MODIS Terra vegetation index and SMAP soil moisture",
    owner: "NASA Earth Science Data and Information System",
    url: "https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api",
    used: "The greenness and soil moisture layers on the map, and the soil moisture at planting time on the results: SMAP Level 4 root-zone soil moisture (satellite readings combined with NASA's land model, about 9 km), read from the published picture with NASA's own colour table. It changes no result.",
    note: "Imagery provided by services from NASA's Global Imagery Browse Services (GIBS).",
  },
  {
    name: "OpenStreetMap: street map and place search (Nominatim)",
    owner: "OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
    used: "The street map, and finding a town or village by name. Data © OpenStreetMap contributors, under the Open Database License.",
  },
  {
    name: "World Imagery",
    owner: "Esri, Vantor, Earthstar Geographics, and the GIS User Community",
    url: "https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9",
    used: "The satellite photo a field is drawn on.",
  },
  {
    name: "WFP food prices and World Bank official exchange rates",
    owner: "UN World Food Programme (through the Humanitarian Data Exchange); World Bank",
    url: "https://data.humdata.org/organization/wfp",
    used: "Wholesale market prices for the countries where no farm price is published, and the yearly exchange rates used to show a price in the grower's currency.",
  },
  {
    name: "NC Soybean Production Guide, chapters 4 and 5",
    owner: "NC State Extension",
    url: "https://content.ces.ncsu.edu/north-carolina-soybean-production-guide",
    used: "The 2-week cover-crop ending guidance when soil moisture is a concern, rye before soybeans, avoiding legumes before soybeans, and soybean planting windows.",
  },
  {
    name: "Winter Annual Cover Crops (AG-439-58)",
    owner: "NC State Extension",
    url: "https://content.ces.ncsu.edu/winter-annual-cover-crops",
    used: "Cover-crop planting windows, erosion protection, and nitrogen notes.",
  },
  {
    name: "Planting to Reduce Head Scab Risk",
    owner: "NC State Extension",
    url: "https://smallgrains.ces.ncsu.edu/news/planting-to-reduce-head-scab-risk/",
    used: "Wheat after corn caution.",
  },
  {
    name: "Cereal Rye, Managing Cover Crops Profitably (3rd ed.)",
    owner: "SARE",
    url: "https://www.sare.org/publications/managing-cover-crops-profitably/nonlegume-cover-crops/cereal-rye/",
    used: "Rye's nitrogen scavenging and late seeding.",
  },
];

export const LIBRARIES: Array<{ name: string; version: string; license: string; use: string }> = [
  { name: "React and React DOM", version: "18.3.1", license: "MIT", use: "Interface" },
  { name: "three.js", version: "0.169.0", license: "MIT", use: "3D farm view" },
  { name: "React Three Fiber", version: "8.17.10", license: "MIT", use: "3D farm view" },
  { name: "Zod", version: "3.23.8", license: "MIT", use: "Checking data from the service" },
  { name: "Hanken Grotesk (Fontsource)", version: "5.1.1", license: "OFL-1.1", use: "All text" },
  { name: "Vite and @vitejs/plugin-react", version: "5.4.11 / 4.3.4", license: "MIT", use: "Build" },
  { name: "TypeScript", version: "5.6.3", license: "Apache-2.0", use: "Build" },
  { name: "Vitest and Testing Library", version: "2.1.8 / 16.1.0", license: "MIT", use: "Tests" },
  { name: "Playwright", version: "1.49.1", license: "Apache-2.0", use: "Browser tests" },
];

export const DISCLOSURES = [
  {
    title: "Sample farm",
    text: "The Union County field, its dates and its soil profile are a fictional example. No real grower's data is used or collected.",
  },
  {
    title: "No partnership implied",
    text: "Naming NASA, USDA, NC State Extension, SARE or the event sponsors credits their public material. It does not mean they reviewed or endorse this tool.",
  },
  {
    title: "AI assistance",
    text: "The team used Claude (Anthropic), through Claude Code, to help write code, tests, interface text, the design system and the synthetic sample-data generator. The team checked every agronomic statement against the sources listed here.",
  },
  {
    title: "Work before the event",
    text: "Some code was written before the event weekend, with the organizers' permission. It is listed in the repository history.",
  },
  {
    title: "Draft data",
    text: "While the screen shows \"Draft sample data\", every number comes from synthetic weather shaped like the service's output, not from NASA.",
  },
];
