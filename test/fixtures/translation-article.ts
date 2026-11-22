/**
 * 本文を訳すテストの記事（martinfowler.com の記事の形を写した英語の本文）。段落、見出し、リスト、
 * 表、引用、リンク、強調、画像、pre ／ code を含む
 */
export const ARTICLE_BODY = `
<h2>Why codemods</h2>
<p>Large codebases change their APIs often. A <a href="https://martinfowler.com/bliki/Refactoring.html">refactoring</a> applied by hand is <strong>slow</strong> and <em>error-prone</em>.</p>
<figure><img src="https://martinfowler.com/articles/codemods/flow.png" alt="Flow of a codemod"><figcaption>How a codemod runs</figcaption></figure>
<ul><li>Find every call site</li><li>Rewrite it with <code>jscodeshift</code></li></ul>
<table><thead><tr><th>Tool</th><th>Language</th></tr></thead><tbody><tr><td>jscodeshift</td><td>JavaScript</td></tr></tbody></table>
<blockquote><p>Automate the boring parts.</p></blockquote>
<pre><code>npx jscodeshift -t transform.js src/</code></pre>
<p>Run the tests after every change.<br>Then commit.</p>
`;
