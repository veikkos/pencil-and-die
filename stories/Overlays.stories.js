import { page } from './page.js';

export default { title: 'Overlays' };

const openSettings = ['click', '.table-view [data-settings]'];
const startWizard = [['click', '#add-char'], ['type', '#w-name', 'Elowen'], ['type', '#w-player', 'Sam']];
const pickPeople = [...startWizard, ['click', '#w-next'], ['click', '[data-pick="elf"]']];

export const Settings = page({ game: 'exploring', steps: [openSettings] });
export const SettingsWithVoice = page({ game: 'exploring', voice: 'on', steps: [openSettings] });
export const CharacterSheet = page({ game: 'combat', steps: [['click', '[data-sheet]']] });
export const CreatureDetails = page({ game: 'combat', steps: [['click', '.pc.creature.enemy']] });
export const WizardWho = page({ game: 'setup', steps: startWizard });
export const WizardPeople = page({ game: 'setup', steps: pickPeople });
export const WizardCalling = page({ game: 'setup', steps: [...pickPeople, ['click', '#w-next'], ['click', '[data-pick="wizard"]']] });
