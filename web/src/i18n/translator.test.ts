import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { languageFor } from "./languages";
import { mask, translatable, unmask } from "./mask";
import { resetTranslatorForTests, samePlaces, startTranslator } from "./translator";

const SWAHILI: Record<string, string> = {
  "Plant maize": "Panda mahindi",
  "About {0} of rain a year falls while the ground is bare.": "Karibu {0} za mvua kwa mwaka hunyesha ardhi ikiwa tupu.",
  "{0} of {1} years": "Miaka {0} kati ya {1}",
  "Search": "Tafuta",
  "Town, address or coordinates": "Mji, anwani au viwianishi",
};
const fake = (table: Record<string, string>, seen: string[][] = []) => async (_lang: string, texts: string[]) => {
  seen.push(texts);
  return { translations: texts.map((t) => table[t] ?? null), status: "complete", reason: null };
};

// The test runner has no working browser storage; a plain in-memory one stands in.
const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  vi.spyOn(window, "localStorage", "get").mockReturnValue({ getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k), clear: () => stored.clear(), key: () => null, length: 0 } as Storage);
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  resetTranslatorForTests();
});

describe("numbers never reach the translator (card 18)", () => {
  it("takes every number out and puts the same ones back", () => {
    const m = mask("  About 682 mm of rain a year, ₹3,376,620 over 10 years. ");
    expect(m.key).toBe("About {0} of rain a year, ₹{1} over {2} years.");
    expect(m.numbers).toEqual(["682 mm", "3,376,620", "10"]);
    expect(unmask("Karibu {0}, ₹{1} kwa miaka {2}.", m)).toBe("  Karibu 682 mm, ₹3,376,620 kwa miaka 10. ");
    // Two results with different numbers share one saved sentence.
    expect(mask("About 534 mm of rain a year, ₹1 over 9 years.").key).toBe(m.key);
  });

  it("refuses a translation that drops, repeats or invents a number's place", () => {
    const m = mask("2 of 10 years");
    expect(unmask("Miaka {0} kati ya {1}", m)).toBe("Miaka 2 kati ya 10");
    expect(unmask("Miaka {0} kati ya {0}", m)).toBeNull();
    expect(unmask("Miaka kati ya {1}", m)).toBeNull();
    expect(unmask("Miaka {0} kati ya {1} na {2}", m)).toBeNull();
    expect(samePlaces("{0} of {1} years", "{1} / {0}")).toBe(true);
    expect(samePlaces("{0} of {1} years", "{0} / {0}")).toBe(false);
  });

  it("takes money and units out with their numbers, so a translation cannot change them", () => {
    const m = mask("About KES 181,560 a year (KES 1,815,600 over 10 years) on 3.4 ha, at 19 °C.");
    expect(m.key).toBe("About {0} a year ({1} over {2} years) on {3}, at {4}.");
    expect(m.numbers).toEqual(["KES 181,560", "KES 1,815,600", "10", "3.4 ha", "19 °C"]);
    // A unit the grower types is kept as written; a currency code alone is kept too.
    expect(mask("A price starts with its currency code: KES/bag, INR/q, USD/t.").numbers).toEqual(["KES/bag", "INR/q", "USD/t"]);
    expect(mask("Paid in KES").key).toBe("Paid in {0}");
    // Capital words that are not money stay words; "2 in 10" is not inches.
    expect(mask("NASA weather, FAO prices").key).toBe("NASA weather, FAO prices");
    expect(mask("Too dry in 2 in 10 years").key).toBe("Too dry in {0} in {1} years");
  });

  it("leaves bare numbers and symbols alone", () => {
    expect(translatable(mask("3.4 ha").key)).toBe(false);
    expect(translatable(mask("KES 51,000").key)).toBe(false);
    expect(translatable(mask("2027").key)).toBe(false);
    expect(translatable(mask("→").key)).toBe(false);
  });
});

describe("the on-screen translator (card 18)", () => {
  it("translates what is on screen, keeps the numbers, and skips anything marked as the grower's own", async () => {
    document.body.innerHTML = `
      <main>
        <h1 translate="no">Shamba la Mama</h1>
        <button>Plant maize</button>
        <p id="rain">About 341 mm of rain a year falls while the ground is bare.</p>
        <p id="dry"><strong>2 of 10 years</strong></p>
        <input placeholder="Town, address or coordinates" value="Kitale" />
        <code>field_corn</code>
      </main>`;
    const seen: string[][] = [];
    const t = startTranslator(languageFor("Swahili")!, document.body, fake(SWAHILI, seen));
    await t.settled();
    expect(document.querySelector("button")!.textContent).toBe("Panda mahindi");
    expect(document.getElementById("rain")!.textContent).toBe("Karibu 341 mm za mvua kwa mwaka hunyesha ardhi ikiwa tupu.");
    expect(document.getElementById("dry")!.textContent).toBe("Miaka 2 kati ya 10");
    const input = document.querySelector("input")!;
    expect(input.getAttribute("placeholder")).toBe("Mji, anwani au viwianishi");
    // What the grower typed and named is neither changed nor sent.
    expect(input.value).toBe("Kitale");
    expect(document.querySelector("h1")!.textContent).toBe("Shamba la Mama");
    expect(seen.flat().join("|")).not.toMatch(/Shamba|Kitale|field_corn|341|\b10\b/);
    expect(document.documentElement.lang).toBe("sw");
    t.stop();
  });

  it("translates text that appears later, asks for each sentence once, and remembers it for the next visit", async () => {
    document.body.innerHTML = `<main><p id="a">Search</p></main>`;
    const seen: string[][] = [];
    const t = startTranslator(languageFor("Swahili")!, document.body, fake(SWAHILI, seen));
    await t.settled();
    const later = document.createElement("p");
    later.textContent = "About 92 mm of rain a year falls while the ground is bare.";
    document.querySelector("main")!.append(later);
    const again = document.createElement("button");
    again.textContent = "Search";
    document.querySelector("main")!.append(again);
    await vi.waitFor(() => expect(later.textContent).toMatch(/^Karibu 92 mm /));
    expect(again.textContent).toBe("Tafuta");
    expect(seen.flat().filter((s) => s === "Search")).toHaveLength(1);
    t.stop();
    await new Promise((r) => setTimeout(r, 900)); // the save is written a moment later

    // A second visit: the saved sentences are used with no call at all.
    document.body.innerHTML = `<main><p id="b">Search</p></main>`;
    const calls: string[][] = [];
    const t2 = startTranslator(languageFor("Swahili")!, document.body, fake({}, calls));
    await t2.settled();
    expect(document.getElementById("b")!.textContent).toBe("Tafuta");
    expect(calls).toEqual([]);
    t2.stop();
  });

  it("keeps English, and says so, when the service cannot translate", async () => {
    document.body.innerHTML = `<main><p id="a">Search</p></main>`;
    const t = startTranslator(languageFor("Swahili")!, document.body, async (_l, texts) => ({ translations: texts.map(() => null), status: "unavailable", reason: "Translation is not set up on this service yet." }));
    await t.settled();
    expect(document.getElementById("a")!.textContent).toBe("Search");
    t.stop();
  });

  it("flips the page for right-to-left scripts and accepts any language by name", () => {
    document.body.innerHTML = `<main></main>`;
    const t = startTranslator(languageFor("Arabic")!, document.body, fake({}));
    expect(document.documentElement.dir).toBe("rtl");
    t.stop();
    expect(languageFor("Tigrinya")).toMatchObject({ name: "Tigrinya", code: "" });
    expect(languageFor("kiswahili")?.name).toBe("Swahili");
    expect(languageFor("English")).toBeNull();
    expect(languageFor("<script>")).toBeNull();
  });

  it("never sends a sentence or a label that holds a name the grower gave, wherever it sits", async () => {
    // Found by hand: a field's name inside a heading ("10-year plan for Lower field") was sent and came back translated.
    stored.set("acre.farms.v1", JSON.stringify({ farms: [{ name: "Wanjiru's land", fields: [{ name: "Lower field", notes: "next to the river" }, { name: "Field 2" }] }] }));
    stored.set("acre.simfield.v1", JSON.stringify({ fields: { f1: { scenarios: [{ from: "custom", label: "Beans first" }, { from: "suggested", label: "Maize, then sorghum" }], readings: [{ note: "hail on the east side" }] } } }));
    document.body.innerHTML = `<main>
      <h2 id="title">10-year plan for Lower field</h2>
      <section id="card" aria-label="Current plan for Lower field"><p id="farm">Fields on Wanjiru's land</p><p id="own">Beans first</p><p id="note">Reading: hail on the east side</p></section>
      <p id="plain">Search</p><p id="default">Field 2 is ready</p><p id="suggested">Maize, then sorghum</p>
    </main>`;
    const seen: string[][] = [];
    const t = startTranslator(languageFor("Swahili")!, document.body, async (_l, texts) => {
      seen.push(texts);
      return { translations: texts.map((x) => `sw:${x}`), status: "complete", reason: null };
    });
    await t.settled();
    const sent = seen.flat().join(" | ");
    expect(sent).not.toMatch(/Lower field|Wanjiru|Beans first|hail|river/);
    expect(document.getElementById("title")!.textContent).toBe("10-year plan for Lower field");
    expect(document.getElementById("card")!.getAttribute("aria-label")).toBe("Current plan for Lower field");
    // Everything else is still translated, including the app's own starting names and suggested plans.
    expect(document.getElementById("plain")!.textContent).toBe("sw:Search");
    expect(document.getElementById("default")!.textContent).toBe("sw:Field 2 is ready".replace("2", "2"));
    expect(document.getElementById("suggested")!.textContent).toBe("sw:Maize, then sorghum");
    t.stop();
  });
});
