import defaults from "../../../skills/web-monitor/defaults.json";
import catalog from "../../../skills/catalog.json";

export const NOTIFICATION_SKILLS = catalog.map(skill => ({ ...defaults, ...skill }));
export const findSkill = (id: string) => NOTIFICATION_SKILLS.find(skill => skill.id === id);
