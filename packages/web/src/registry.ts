import type { SavedView } from "@sinapsi/shared";
import { useEffect, useState } from "react";
import { SERVER_HOST } from "./collab";

/** Client side of the view registry (shared by every board on the server). */

const BASE = `${location.protocol}//${SERVER_HOST}/api/views`;
let views: SavedView[] = [];
const subscribers = new Set<(v: SavedView[]) => void>();

export async function refreshViews() {
  try {
    const res = await fetch(BASE);
    if (!res.ok) return;
    views = (await res.json()) as SavedView[];
    for (const fn of subscribers) fn(views);
  } catch {
    // server unreachable: keep what we have
  }
}

export function useSavedViews(): SavedView[] {
  const [list, setList] = useState(views);
  useEffect(() => {
    subscribers.add(setList);
    void refreshViews();
    return () => {
      subscribers.delete(setList);
    };
  }, []);
  return list;
}

export interface SaveViewInput {
  name?: string;
  title: string;
  description: string;
  required: string[];
  types: string[];
  html: string;
  width: number;
  height: number;
  author: string;
}

export async function saveView(input: SaveViewInput): Promise<SavedView> {
  const res = await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const body = (await res.json()) as SavedView & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Salvataggio non riuscito");
  await refreshViews();
  return body;
}

export async function deleteView(name: string) {
  await fetch(`${BASE}/${encodeURIComponent(name)}`, { method: "DELETE" });
  await refreshViews();
}
