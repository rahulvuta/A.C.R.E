import type { GlobalApi } from "../../state/useGlobal";
import { Banner } from "../../ui/components";

/** Where the app's answers come from: sample fixtures, no service, or (silent) the live service. */
export function SourceBanner({ source }: { source: GlobalApi["source"] }) {
  if (source === "fixtures")
    return (
      <Banner kind="synthetic">
        <strong>Sample responses.</strong> Made-up answers for trying the screens; not NASA data and not your place.
      </Banner>
    );
  if (source === "none")
    return (
      <Banner kind="info">
        Finding a farm needs the A.C.R.E service, which is not connected in this build. The Union County demo works offline.
      </Banner>
    );
  return null;
}
