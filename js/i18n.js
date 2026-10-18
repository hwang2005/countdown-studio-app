/**
 * @file js/i18n.js
 * Internationalisation dictionary for Countdown Studio.
 * Structured for English (default) and Vietnamese ('vi') expansion.
 */

export const STRINGS = {
  en: {
    appTitle: 'Countdown Studio',
    soloMode: 'Solo Practice',
    versusHost: 'Live Versus Host',
    versusDisplay: 'Stage Display',
    unitTests: 'Unit Tests',
    settings: 'Settings',
    howToPlay: 'How to Play',
    vowel: 'Vowel',
    consonant: 'Consonant',
    randomPick: 'Random 9',
    startClock: 'Start 30s Clock',
    submitAnswer: 'Submit Answer',
    dictionaryCorner: 'Dictionary Corner',
    roundLetters: 'Letters Round',
    roundNumbers: 'Numbers Round',
    roundConundrum: 'Countdown Conundrum',
    timeUp: 'Time!',
    validWord: 'Valid dictionary word',
    invalidWord: 'Not in dictionary or invalid letters',
    exactTarget: 'Exact target hit!',
    withinFive: 'Within 5 of target',
    withinTen: 'Within 10 of target',
    outsideRange: 'More than 10 away'
  },
  vi: {
    appTitle: 'Countdown Studio',
    soloMode: 'Luyện Tập Cá Nhân',
    versusHost: 'Bảng Điều Khiển Đối Kháng',
    versusDisplay: 'Màn Hình Sân Khấu',
    unitTests: 'Kiểm Thử Đơn Vị',
    settings: 'Cài Đặt',
    howToPlay: 'Luật Chơi',
    vowel: 'Nguyên Âm',
    consonant: 'Phụ Âm',
    randomPick: 'Chọn Ngẫu Nhiên',
    startClock: 'Bắt Đầu 30 Giây',
    submitAnswer: 'Gửi Đáp Án',
    dictionaryCorner: 'Góc Từ Điển',
    roundLetters: 'Vòng Chữ Cái',
    roundNumbers: 'Vòng Con Số',
    roundConundrum: 'Vòng Giải Đố 9 Chữ',
    timeUp: 'Hết Giờ!',
    validWord: 'Từ hợp lệ trong từ điển',
    invalidWord: 'Từ không hợp lệ',
    exactTarget: 'Chính xác tuyệt đối!',
    withinFive: 'Cách mục tiêu ≤ 5',
    withinTen: 'Cách mục tiêu ≤ 10',
    outsideRange: 'Cách mục tiêu > 10'
  }
};

let currentLang = 'en';

/**
 * Sets the active UI language ('en' | 'vi').
 * @param {string} lang
 */
export function setLanguage(lang) {
  if (STRINGS[lang]) {
    currentLang = lang;
  }
}

/**
 * Retrieves a localised string by key.
 * @param {string} key
 * @returns {string}
 */
export function t(key) {
  return (STRINGS[currentLang] && STRINGS[currentLang][key]) || STRINGS.en[key] || key;
}
