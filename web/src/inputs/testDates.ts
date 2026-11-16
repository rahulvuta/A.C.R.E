import { fireEvent, screen, within } from "@testing-library/react";

/* Test helpers for the day-and-month date picker: read a date as MM-DD, or choose one. */
export const dateValue = (label: string): string => screen.getByRole("group", { name: label }).getAttribute("data-value") ?? "";
export function setDate(label: string, monthDay: string): void {
  const group = within(screen.getByRole("group", { name: label }));
  fireEvent.change(group.getByRole("combobox", { name: `${label}: month` }), { target: { value: monthDay.slice(0, 2) } });
  fireEvent.change(group.getByRole("combobox", { name: `${label}: day` }), { target: { value: monthDay.slice(3) } });
}
