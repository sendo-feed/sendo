/** Feedly が書き出す形の OPML */
export const FEEDLY_OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>subscriptions in feedly Cloud</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Cloudflare Blog" title="Cloudflare Blog"
        xmlUrl="https://blog.cloudflare.com/rss/" htmlUrl="https://blog.cloudflare.com/"/>
      <outline type="rss" text="Example" title="Example" xmlUrl="HTTPS://Example.com/feed.xml#x"/>
    </outline>
    <outline text="  セキュリティ  " title="  セキュリティ  ">
      <outline type="rss" text="JVN" xmlUrl="https://jvndb.jvn.jp/ja/rss/jvndb_new.rdf"/>
      <outline type="rss" text="dup" xmlUrl="https://example.com/feed.xml"/>
      <outline type="rss" text="internal" xmlUrl="http://169.254.169.254/latest"/>
      <outline type="rss" text="bad" xmlUrl="javascript:alert(1)"/>
    </outline>
    <outline type="rss" text="No folder" xmlUrl="https://top.example/atom.xml"/>
    <outline text="Empty" xmlUrl=""/>
  </body>
</opml>`;
