import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";
import { resetUnitsForTests } from "./ui/units";

// Tests run with fixed units (acres, millimetres, °C) unless a test sets its own.
beforeEach(() => resetUnitsForTests({ area: "ac", rain: "mm", temp: "C", currency: null }));
