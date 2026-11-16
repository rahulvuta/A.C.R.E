import { setUnits, useUnits, type Units } from "./units";

/*
  The one place units are changed (card 15). Four short choices; the summary line shows what
  is in use. It sits in the sidebar of the six steps and of "My fields".
*/
const CURRENCIES = ["USD", "EUR", "GBP", "KES", "UGX", "TZS", "NGN", "GHS", "ZAR", "ETB", "XOF", "INR", "PKR", "BDT", "CNY", "IDR", "PHP", "VND", "BRL", "ARS", "MXN", "COP", "CAD", "AUD"];

export function UnitsControl() {
  const u = useUnits();
  const currencies = u.currency && !CURRENCIES.includes(u.currency) ? [u.currency, ...CURRENCIES] : CURRENCIES;
  return (
    <details className="un">
      <summary>
        <span className="un-title">Units</span>
        <span className="un-now" translate="no">
          {u.area === "ha" ? "ha" : "ac"} · {u.rain} · °{u.temp}
          {u.currency ? ` · ${u.currency}` : ""}
        </span>
      </summary>
      <div className="un-body">
        <label>
          Field size
          <select aria-label="Field size unit" value={u.area} onChange={(e) => setUnits({ area: e.target.value as Units["area"] })}>
            <option value="ha">Hectares</option>
            <option value="ac">Acres</option>
          </select>
        </label>
        <label>
          Rain
          <select aria-label="Rain unit" value={u.rain} onChange={(e) => setUnits({ rain: e.target.value as Units["rain"] })}>
            <option value="mm">Millimetres</option>
            <option value="in">Inches</option>
          </select>
        </label>
        <label>
          Temperature
          <select aria-label="Temperature unit" value={u.temp} onChange={(e) => setUnits({ temp: e.target.value as Units["temp"] })}>
            <option value="C">°C</option>
            <option value="F">°F</option>
          </select>
        </label>
        <label>
          Money
          <select aria-label="Currency" value={u.currency ?? ""} onChange={(e) => setUnits({ currency: e.target.value || null })}>
            <option value="">Not set</option>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <p className="un-note">Money results stay in the currency you typed your prices in.</p>
      </div>
    </details>
  );
}
