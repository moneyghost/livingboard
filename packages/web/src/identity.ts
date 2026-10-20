export interface Identity {
  name: string;
  color: string;
}

const NAMES = ["Ada", "Ben", "Clara", "Dan", "Ella", "Felix", "Grace", "Ivy", "Leo", "Max", "Nora", "Oscar", "Paula", "Rose", "Sam", "Theo", "Vera"];
const COLORS = ["#4c6ef5", "#12b886", "#e64980", "#7950f2", "#15aabf", "#40c057", "#fab005", "#228be6"];

const KEY = "livingboard:identity";

export function loadIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Identity;
  } catch {
    // private mode or blocked storage: fall through to a fresh identity
  }
  const me = {
    name: NAMES[Math.floor(Math.random() * NAMES.length)],
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(me));
  } catch {
    // ignore
  }
  return me;
}
