/**
 * @file js/solver/trie.js
 * Prefix Trie data structure for O(L) prefix pruning when solving 9-letter Countdown
 * letter selections. Zero DOM access. Fully unit-testable.
 */

export class TrieNode {
  constructor() {
    /** @type {Map<string, TrieNode>} */
    this.children = new Map();
    /** @type {boolean} */
    this.isWord = false;
  }
}

export class WordTrie {
  constructor() {
    this.root = new TrieNode();
    this.wordCount = 0;
  }

  /**
   * Inserts a lowercase word into the Trie.
   * @param {string} word
   */
  insert(word) {
    const clean = word.trim().toLowerCase();
    if (!clean) return;
    let node = this.root;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    if (!node.isWord) {
      node.isWord = true;
      this.wordCount += 1;
    }
  }

  /**
   * Checks whether `word` exists in the Trie.
   * @param {string} word
   * @returns {boolean}
   */
  has(word) {
    const clean = String(word).trim().toLowerCase();
    if (!clean) return false;
    let node = this.root;
    for (let i = 0; i < clean.length; i++) {
      node = node.children.get(clean[i]);
      if (!node) return false;
    }
    return node.isWord;
  }

  /**
   * Finds all valid words constructible from the given array of letters
   * (using each letter tile at most once) via DFS over the Trie.
   *
   * @param {string[]} letters Array of 9 drawn letters
   * @param {number} [minLength=3] Minimum word length to include
   * @returns {string[]} Uppercase words sorted by length descending, then alphabetically
   */
  findAllSubwords(letters, minLength = 3) {
    const counts = new Map();
    for (const ch of letters) {
      const low = String(ch).toLowerCase();
      counts.set(low, (counts.get(low) || 0) + 1);
    }

    const found = [];

    /**
     * @param {TrieNode} node
     * @param {string} prefix
     */
    const dfs = (node, prefix) => {
      if (node.isWord && prefix.length >= minLength) {
        found.push(prefix.toUpperCase());
      }
      for (const [ch, childNode] of node.children.entries()) {
        const remaining = counts.get(ch) || 0;
        if (remaining > 0) {
          counts.set(ch, remaining - 1);
          dfs(childNode, prefix + ch);
          counts.set(ch, remaining);
        }
      }
    };

    dfs(this.root, '');

    found.sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      return a.localeCompare(b);
    });

    return found;
  }
}
