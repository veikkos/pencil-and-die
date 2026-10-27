/** @type { import('@storybook/html-vite').StorybookConfig } */
export default {
  framework: '@storybook/html-vite',
  stories: ['../stories/**/*.stories.js'],
  // The page runs as-is from public/, inside a frame whose API answers from the fixtures.
  staticDirs: [
    { from: '../public', to: '/app' },
    { from: '../stories/frame', to: '/frame' },
    { from: '../stories/fixtures', to: '/fixtures' },
  ],
  core: { disableTelemetry: true },
};
