/** 音乐模块内联图标（纯文本/Unicode，零外部依赖、零 CDN） */
const GLYPHS = {
  play: '▶', pause: '❚❚', prev: '⏮', next: '⏭',
  shuffle: '⤨', repeat: '↻', 'repeat-one': '↻¹',
  volume: '🔊', mute: '🔇', note: '♫',
};
export function musicIcon(name) { return GLYPHS[name] || '·'; }
