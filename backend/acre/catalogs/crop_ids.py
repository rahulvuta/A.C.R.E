"""The generalised crop list (card B2): FAO-style crop ids, plain names, roles, families, aliases.

Ids follow FAO commodity naming in snake case (``maize``, ``soybean``, ``winter_wheat``, ...). The
old NC ids stay valid through aliases: ``field_corn`` is ``maize``. A catalog keeps whatever ids it
was written with (the NC v2 catalog says ``field_corn``), so a plan's crop id is mapped onto the
catalog in use with :func:`id_in_catalog`, in either direction.

``family`` is the botanical family, used to count crop-family diversity (P2). It is a fact about
the plant, not a recommendation.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class CropId:
    crop_id: str
    name: str
    role: str  # cash_crop | cover_crop (a few can be both; see ``roles``)
    family: str
    aliases: tuple[str, ...] = ()
    roles: tuple[str, ...] = field(default=())

    def all_roles(self) -> tuple[str, ...]:
        return self.roles or (self.role,)


_C = CropId
#: Every crop id the API accepts. SAGE (Sacks et al. 2010) covers the cash crops; the cover crops
#: are the common temperate and tropical covers named in the NC catalog and SARE's handbook.
CROPS: tuple[CropId, ...] = (
    _C("maize", "Maize (corn)", "cash_crop", "Poaceae", ("field_corn", "corn", "maize_main")),
    _C("maize_second", "Maize (corn), second season", "cash_crop", "Poaceae",
       ("safrinha_maize",)),
    _C("soybean", "Soybean", "cash_crop", "Fabaceae", ("soybeans", "soy")),
    _C("winter_wheat", "Winter wheat", "cash_crop", "Poaceae", ("wheat_winter",)),
    _C("spring_wheat", "Spring wheat", "cash_crop", "Poaceae", ("wheat", "wheat_spring")),
    _C("rice", "Rice", "cash_crop", "Poaceae", ("paddy_rice", "rice_main")),
    _C("rice_second", "Rice, second season", "cash_crop", "Poaceae"),
    _C("sorghum", "Sorghum", "cash_crop", "Poaceae", ("grain_sorghum",)),
    _C("sorghum_second", "Sorghum, second season", "cash_crop", "Poaceae"),
    _C("barley", "Barley (spring)", "cash_crop", "Poaceae", ("spring_barley",)),
    _C("winter_barley", "Winter barley", "cash_crop", "Poaceae"),
    _C("oats", "Oats (spring)", "cash_crop", "Poaceae", ("spring_oats",)),
    _C("winter_oats", "Winter oats", "cash_crop", "Poaceae"),
    _C("winter_rye", "Winter rye (grain)", "cash_crop", "Poaceae", ("rye_grain",)),
    _C("millet", "Millet", "cash_crop", "Poaceae"),
    _C("cotton", "Cotton", "cash_crop", "Malvaceae"),
    _C("groundnut", "Groundnut (peanut)", "cash_crop", "Fabaceae", ("peanut", "peanuts")),
    _C("pulses", "Pulses (dry beans, peas, lentils)", "cash_crop", "Fabaceae"),
    _C("sunflower", "Sunflower", "cash_crop", "Asteraceae"),
    _C("winter_rapeseed", "Winter rapeseed (canola)", "cash_crop", "Brassicaceae",
       ("canola", "rapeseed")),
    _C("sugarbeet", "Sugar beet", "cash_crop", "Amaranthaceae", ("sugar_beet",)),
    _C("potato", "Potato", "cash_crop", "Solanaceae", ("potatoes",)),
    _C("sweet_potato", "Sweet potato", "cash_crop", "Convolvulaceae", ("sweet_potatoes",)),
    _C("cassava", "Cassava", "cash_crop", "Euphorbiaceae"),
    _C("yam", "Yam", "cash_crop", "Dioscoreaceae", ("yams",)),
    # cover crops
    _C("cereal_rye", "Cereal rye (cover)", "cover_crop", "Poaceae", ("rye_cover",)),
    _C("crimson_clover", "Crimson clover", "cover_crop", "Fabaceae"),
    _C("hairy_vetch", "Hairy vetch", "cover_crop", "Fabaceae"),
    _C("black_oat", "Black oat", "cover_crop", "Poaceae", ("avena_strigosa",)),
    _C("oats_cover", "Oats (cover)", "cover_crop", "Poaceae"),
    _C("radish_cover", "Forage radish", "cover_crop", "Brassicaceae", ("tillage_radish",)),
    _C("vicia_sativa", "Common vetch", "cover_crop", "Fabaceae", ("common_vetch",)),
    _C("sunn_hemp", "Sunn hemp", "cover_crop", "Fabaceae"),
    _C("mustard_cover", "Mustard (cover)", "cover_crop", "Brassicaceae"),
    _C("berseem_clover", "Berseem clover", "cover_crop", "Fabaceae"),
)  # fmt: skip

BY_ID: dict[str, CropId] = {c.crop_id: c for c in CROPS}
_ALIAS: dict[str, str] = {a: c.crop_id for c in CROPS for a in c.aliases}


#: Crops researched into the crop library (card S4), registered at run time. They are looked up
#: only after the built-in list, so they can never shadow a built-in id or alias.
EXTRA: dict[str, CropId] = {}
_EXTRA_ALIAS: dict[str, str] = {}
_LOADED: list[str] = []  # the library version last loaded


def register(c: CropId) -> None:
    if c.crop_id in BY_ID or c.crop_id in _ALIAS:
        return
    EXTRA[c.crop_id] = c
    for a in c.aliases:
        if a not in BY_ID and a not in _ALIAS:
            _EXTRA_ALIAS[a] = c.crop_id


def clear_extra() -> None:
    EXTRA.clear()
    _EXTRA_ALIAS.clear()
    _LOADED.clear()


def _extra(key: str) -> str | None:
    if key in EXTRA:
        return key
    if key in _EXTRA_ALIAS:
        return _EXTRA_ALIAS[key]
    try:  # a crop researched by another worker since we last looked
        from acre.croplib import library

        if library.load_extras(_LOADED):
            return key if key in EXTRA else _EXTRA_ALIAS.get(key)
    except Exception:  # noqa: BLE001 - the library is optional; a miss stays a miss
        return None
    return None


def canonical(crop_id: str | None) -> str | None:
    """The FAO-style id for ``crop_id`` (an id or an alias), or ``None`` if it is not a crop.
    Crops researched into the crop library (S4) are known too."""
    if not crop_id or not isinstance(crop_id, str):
        return None
    key = crop_id.strip().lower()
    if key in BY_ID:
        return key
    if key in _ALIAS:
        return _ALIAS[key]
    return _extra(key)


def is_known(crop_id: str | None) -> bool:
    return canonical(crop_id) is not None


def info(crop_id: str | None) -> CropId | None:
    c = canonical(crop_id)
    return (BY_ID.get(c) or EXTRA.get(c)) if c else None


def family_of(crop_id: str | None) -> str | None:
    i = info(crop_id)
    return i.family if i else None


def equivalents(crop_id: str) -> list[str]:
    """``crop_id``, its canonical id and every alias of it (deterministic order)."""
    i = info(crop_id)
    if i is None:
        return [crop_id]
    out = [crop_id, i.crop_id, *i.aliases]
    return list(dict.fromkeys(out))


def id_in_catalog(crop_id: str, catalog_ids: set[str] | dict) -> str | None:
    """The id this catalog uses for ``crop_id`` (``maize`` -> ``field_corn`` in NC), or None."""
    for cand in equivalents(crop_id):
        if cand in catalog_ids:
            return cand
    return None
