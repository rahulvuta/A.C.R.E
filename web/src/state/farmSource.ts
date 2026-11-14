/*
  Where the screens get the farm and the selected field: C's store (`farm/hooks.ts`,
  localStorage `acre.farms.v1`). Kept as a re-export so older imports keep working.
*/
export { useFarms, useSelectedField, selectField, putFarm, updateFieldPlan } from "../farm/hooks";
import { resetFarmStoreForTests } from "../farm/hooks";
export const resetFarmSource = () => resetFarmStoreForTests();
