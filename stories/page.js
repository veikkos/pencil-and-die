// A story of the whole page: the real public/app.js in a frame, fed by fixtures (see frame/mock.js).

export const pageArgTypes = {
  lang: { name: 'Language', control: 'inline-radio', options: ['en', 'fi'] },
  level: { name: 'Rules level', control: 'inline-radio', options: ['beginner', 'casual', 'intermediate'] },
  fallen: { name: 'Fallen heroes', control: 'inline-radio', options: ['knockout', 'death'] },
  dm: { name: 'DM status', control: 'inline-radio', options: ['offline', 'listening', 'thinking'] },
};

export const pageArgs = { lang: 'en', level: 'beginner', fallen: 'knockout', dm: 'listening' };

/** `game` names a fixture in fixtures/data.json (none = lobby); `steps` are clicks and typing done once it is up. */
export function page({ game, steps = [], ...rest } = {}) {
  return {
    args: { ...pageArgs, dm: game?.startsWith('setup') ? 'offline' : 'listening' },
    argTypes: pageArgTypes,
    render: (args) => {
      const q = new URLSearchParams({ ...args, ...(game ? { game } : {}), ...rest, steps: JSON.stringify(steps) });
      const frame = document.createElement('iframe');
      frame.src = `frame/index.html?${q}`;
      frame.title = 'The Pencil & Die';
      frame.style.cssText = 'display:block;width:100%;height:100vh;border:0';
      return frame;
    },
  };
}
