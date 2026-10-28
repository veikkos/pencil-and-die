import { page } from './page.js';

export default { title: 'Screens' };

export const Lobby = page();
export const PartySetup = page({ game: 'setup' });
export const EmptyParty = page({ game: 'setupEmpty' });
export const Exploring = page({ game: 'exploring' });
export const ScrolledBack = page({ game: 'exploring', steps: [['scroll', '#story', '0']] });
export const GatheringInitiative = page({ game: 'initiative' });
export const Combat = page({ game: 'combat' });
export const HeroDying = page({ game: 'dying' });
