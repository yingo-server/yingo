/**
 * 音乐模块图标：固化 tabler outline SVG（MIT）。
 * 音乐坞为深色玻璃底，按钮统一 filter:invert(1) 显示原黑描边。
 */
const BASE = '../../assets/icons/';
export const musicIconUrl = {
  play: BASE + 'player-play.svg',
  pause: BASE + 'player-pause.svg',
  prev: BASE + 'player-skip-back.svg',
  next: BASE + 'player-skip-forward.svg',
  shuffle: BASE + 'arrows-shuffle.svg',
  repeat: BASE + 'repeat.svg',
  'repeat-one': BASE + 'repeat.svg',
  volume: BASE + 'volume.svg',
  mute: BASE + 'volume.svg',
  note: BASE + 'music.svg',
  list: BASE + 'playlist.svg',
};
/** 生成 <img> 图标 markup（按钮内联） */
export function musicIcon(name) {
  const url = musicIconUrl[name] || musicIconUrl.note;
  return `<img src="${url}" alt="" style="width:16px;height:16px;filter:invert(1);pointer-events:none">`;
}
