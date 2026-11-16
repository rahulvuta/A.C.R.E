# Recorded NASA POWER responses (test fixtures)

Public NASA data, recorded once so tests never touch the network.

| File | What |
|---|---|
| `pergamino_cell_-34.000_-60.625.json` | Untouched POWER Daily API v2.10.3 response for the centre of the MERRA-2 grid cell containing Pergamino, Buenos Aires, Argentina (cell `cell_-34.000_-60.625`; the cell centre, not a farm). Parameters `PRECTOTCORR,T2M_MAX,T2M_MIN,T2M,GWETTOP,GWETROOT`, community `AG`, time standard `LST`, 1981-01-01 to 2026-11-12. Retrieved 2026-11-14T16:41:05Z. The last day (2026-11-12) is POWER's fill value (-999) for every parameter, so the last complete day is 2026-11-11. `header.sources` is `MERRA2, GEOSIT, POWER` (recent days come from GEOS-IT). |

Query: `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR%2CT2M_MAX%2CT2M_MIN%2CT2M%2CGWETTOP%2CGWETROOT&community=AG&longitude=-60.625&latitude=-34&start=19810101&end=20261112&format=JSON&time-standard=LST`
