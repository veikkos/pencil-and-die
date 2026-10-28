import { page } from './page.js';

export default { title: 'Overlays' };

const openSettings = ['click', '.table-view [data-settings]'];
const startWizard = [['click', '#add-char'], ['type', '#w-name', 'Elowen'], ['type', '#w-player', 'Sam']];
const pickPeople = [...startWizard, ['click', '#w-next'], ['click', '[data-pick="elf"]']];

export const Settings = page({ game: 'exploring', steps: [openSettings] });
export const SettingsWithVoice = page({ game: 'exploring', voice: 'on', steps: [openSettings] });
const sheetOf = (name, tab) => [['click', '.pc.hero', name], ...(tab ? [['click', `.sheet [data-tab="${tab}"]`]] : [])];
export const CharacterSheet = page({ game: 'combat', steps: sheetOf('Mira') });
const at = (story, args) => ({ ...story, args: { ...story.args, ...args } });
export const CasterSheet = at(page({ game: 'combat', steps: sheetOf('Elowen') }), { level: 'intermediate' });
export const SheetWithEffects = at(page({ game: 'combat', steps: sheetOf('Torvald') }), { level: 'casual' });
export const SheetInventory = page({ game: 'combat', steps: sheetOf('Mira', 'inventory') });
export const SheetFeatures = page({ game: 'combat', steps: sheetOf('Elowen', 'features') });
export const SheetDying = page({ game: 'dying', steps: sheetOf('Mira') });
export const SheetTip = at(page({ game: 'combat', steps: [...sheetOf('Mira'), ['click', '.sheet .tip-row', 'Acrobatics']] }), { level: 'intermediate' });
export const SheetItemNote = page({ game: 'combat', steps: [...sheetOf('Mira', 'inventory'), ['click', '.sheet .tip', 'Brass clapper']] });
export const LevelUpChoices = at(page({ game: 'levelling', steps: [['click', '.lvl-chip']] }), { level: 'intermediate' });
export const LevelUpBard = at(page({ game: 'levelling', steps: [['click', '.pc.hero', 'Lark'], ['click', '.sheet [data-levelup]']] }), { level: 'casual' });
export const LevelUpBeginner = at(page({ game: 'levelling', steps: [['click', '.lvl-chip']] }), { level: 'beginner' });
export const LevelFiveFighter = at(page({ game: 'levelling', steps: sheetOf('Torvald') }), { level: 'intermediate' });
export const LevelFiveCleric = at(page({ game: 'levelling', steps: sheetOf('Ada', 'features') }), { level: 'casual' });
export const CreatureDetails = page({ game: 'combat', steps: [['click', '.pc.creature.enemy']] });
export const WizardWho = page({ game: 'setup', steps: startWizard });
export const WizardPeople = page({ game: 'setup', steps: pickPeople });
export const WizardCalling = page({ game: 'setup', steps: [...pickPeople, ['click', '#w-next'], ['click', '[data-pick="wizard"]']] });
