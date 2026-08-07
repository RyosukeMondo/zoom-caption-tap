// Seeds sample meetings into the archive so the dashboard, timeline, speaker
// comparison and review mode can be demoed without sitting through a real
// Zoom call.
//
// Exposed as MeetingSamples.seed() and offered from the dashboard's empty
// state only — when a real archive exists there is no way to trigger this,
// so sample data can never mix into a user's own meetings.
//
// Goes through MeetingArchive.build()/save() rather than writing records by
// hand, so samples are produced by exactly the same code path as real
// meetings and cannot drift from the real schema.
//
// Deterministic: the PRNG is seeded, so re-running replaces the same four
// meetings (same ids) instead of piling up new ones.
//

(function (global) {
  "use strict";

  async function seed() {
  // Mulberry32. Deterministic so a re-run is idempotent, and so a screenshot
  // taken today matches one taken next week.
  function rng(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const MIN = 60000;

  /**
   * Turns a script of [speaker, text] beats into timestamped utterances.
   *
   * Gaps are drawn from the speaker's own pace, and a same-speaker beat is
   * kept tight (2-6s) so consecutive lines land inside archive.js's 10s run
   * window — that is what makes the estimated-speaking-time figure exercise
   * its measured branch rather than falling back to chars/sec for every line.
   */
  function lay(script, startAt, random, { handoffMs = [2000, 8000], sameMs = [2500, 7000] } = {}) {
    const out = [];
    let at = startAt;
    let prev = null;
    script.forEach(([speaker, text], i) => {
      const [lo, hi] = speaker === prev ? sameMs : handoffMs;
      at += Math.round(lo + random() * (hi - lo));
      out.push({ messageId: `seed-${startAt}-${i}`, speaker, text, at });
      prev = speaker;
    });
    return out;
  }

  /** Repeats a beat pattern to bulk out a meeting to a realistic length. */
  function expand(pattern, times) {
    const out = [];
    for (let i = 0; i < times; i++) out.push(...pattern);
    return out;
  }

  const now = Date.now();
  const day = 86400000;

  // ---------------------------------------------------------------------
  // 1. Product prioritisation — 4 speakers, balanced, ~40 min.
  //    Exercises: multi-speaker bars, dense timeline, full note buckets.
  // ---------------------------------------------------------------------
  const r1 = rng(1001);
  const m1Script = expand(
    [
      ["田中", "では、次のリリースに入れる機能を決めていきましょう。"],
      ["佐藤", "優先度としては、やはり検索の改善が一番効くと思っています。"],
      ["田中", "根拠はありますか。"],
      ["佐藤", "問い合わせの内訳を見ると、四分の一以上が検索で目的の情報にたどり着けないというものでした。"],
      ["鈴木", "それは私も感じています。特に表記ゆれの吸収ができていないですね。"],
      ["佐藤", "そうなんです。「電気ポット」と「電気ケトル」が別物として扱われてしまう。"],
      ["中村", "実装コストはどれくらい見ていますか。"],
      ["佐藤", "全文検索の基盤を入れ替えるとなると、二週間は見たいところです。"],
      ["中村", "二週間だと今回のリリースには間に合わないのでは。"],
      ["田中", "段階的にできませんか。まず表記ゆれの辞書だけ入れるとか。"],
      ["佐藤", "それなら三日でできます。効果は限定的ですが。"],
      ["鈴木", "限定的でも、問い合わせが減るなら価値はあると思います。"],
      ["田中", "ではまず辞書対応を今回のリリースに入れて、基盤の入れ替えは次回にしましょう。"],
      ["中村", "承知しました。工数は私のほうで確保します。"],
      ["鈴木", "あと、モバイルでの表示崩れの報告が続いています。"],
      ["田中", "こちらの優先度はどうしましょうか。"],
      ["鈴木", "件数は少ないのですが、特定の端末で完全に操作できなくなるようです。"],
      ["中村", "それは優先度を上げたほうがいいですね。使えないのは致命的です。"],
      ["田中", "では辞書対応とモバイル修正の二本立てで進めます。"],
      ["佐藤", "スケジュールは私のほうで引き直して共有します。"],
    ],
    20,
  );
  const m1 = lay(m1Script, now - 3 * day + 10 * 60 * 60000, r1);

  // ---------------------------------------------------------------------
  // 2. Standup — 3 speakers, ~6 min. Exercises the short-meeting layout and
  //    a timeline with very few buckets.
  // ---------------------------------------------------------------------
  const r2 = rng(2002);
  const m2 = lay(
    [
      ["山本", "おはようございます。朝会を始めます。"],
      ["山本", "昨日の進捗から共有をお願いします。"],
      ["伊藤", "昨日は検索APIの改修を進めて、テストまで通りました。"],
      ["伊藤", "今日はレビュー対応をして、問題なければマージします。"],
      ["渡辺", "私は管理画面の不具合を調べていました。"],
      ["渡辺", "原因は特定できたので、今日中に修正を出します。"],
      ["山本", "ブロッカーはありますか。"],
      ["伊藤", "特にありません。"],
      ["渡辺", "こちらも大丈夫です。"],
      ["山本", "では以上とします。ありがとうございました。"],
    ],
    now - 1 * day + 9 * 60 * 60000 + 30 * MIN,
    r2,
  );

  // ---------------------------------------------------------------------
  // 3. Customer discovery — 2 speakers, lopsided (the customer talks far
  //    more). Exercises a strongly asymmetric speaker bar chart.
  // ---------------------------------------------------------------------
  const r3 = rng(3003);
  const m3Script = expand(
    [
      ["営業担当", "本日はお時間をいただきありがとうございます。"],
      ["顧客・小林", "こちらこそ。実は前々から困っていたことがありまして。"],
      ["顧客・小林", "うちはコールセンターを内製でやっているのですが、商品数が多すぎるんです。"],
      ["顧客・小林", "オペレーターが商品知識を覚えきれず、保留時間が長くなってしまう。"],
      ["顧客・小林", "新人だと一件あたり十分近くかかることもあります。"],
      ["営業担当", "現在はどのように調べられているのでしょうか。"],
      ["顧客・小林", "社内のファイルサーバーにマニュアルが置いてあるので、それを検索しています。"],
      ["顧客・小林", "ただ、ファイル名がバラバラで、目当てのものが出てこないことが多くて。"],
      ["顧客・小林", "結局ベテランに聞きに行くことになるんです。それが一番早いので。"],
      ["顧客・小林", "でもそうすると、ベテランの手が止まってしまいますよね。"],
      ["営業担当", "なるほど。属人化しているということですね。"],
      ["顧客・小林", "まさにそうです。その人が休むとその日は回らなくなる。"],
      ["営業担当", "会話の内容から自動で該当のマニュアルを出す、という形はいかがでしょうか。"],
      ["顧客・小林", "それができるなら理想的ですね。オペレーターが何も操作しなくていいなら。"],
      ["顧客・小林", "ただ、お客様の言い方はバラバラなんですよ。"],
      ["顧客・小林", "同じ商品でも、型番で言う方もいれば、色で言う方もいる。"],
      ["営業担当", "そこは表記ゆれを吸収する仕組みを入れる想定です。"],
      ["顧客・小林", "それは助かります。導入までどれくらいかかりますか。"],
      ["営業担当", "データの整理状況にもよりますが、一ヶ月程度を見ています。"],
      ["顧客・小林", "費用感も含めて、一度提案書をいただけますか。"],
    ],
    15,
  );
  const m3 = lay(m3Script, now - 5 * day + 14 * 60 * 60000, r3);

  // ---------------------------------------------------------------------
  // 4. Quarterly review — 5 speakers, ~70 min, deliberately uneven: 高橋
  //    speaks twice at the very start and then goes silent for the rest.
  //    This is the case the speaker panel was built for — spotting who has
  //    dropped out of the conversation.
  // ---------------------------------------------------------------------
  const r4 = rng(4004);
  const m4Start = now - 8 * day + 13 * 60 * 60000;
  const m4Opening = lay(
    [
      ["部長・松本", "四半期の振り返りを始めます。まず数字の共有からお願いします。"],
      ["高橋", "はい。売上は前期比で112%、目標に対しては98%の着地です。"],
      ["高橋", "未達の主因は、大型案件が一件、翌期にずれ込んだことです。"],
      ["部長・松本", "ありがとうございます。ずれ込みの理由は。"],
      ["清水", "先方の予算承認が遅れたためです。失注ではありません。"],
    ],
    m4Start,
    r4,
  );
  const m4Body = lay(
    expand(
      [
        ["部長・松本", "では、次期の見通しについて議論しましょう。"],
        ["清水", "パイプラインは積み上がっているので、翌期は問題ないと見ています。"],
        ["森", "ただ、リードの質が下がっている感覚があります。"],
        ["清水", "そうですね。商談化率はこの三ヶ月で少し落ちています。"],
        ["森", "流入経路を見直したほうがいいかもしれません。"],
        ["部長・松本", "具体的にはどのあたりですか。"],
        ["森", "広告経由のリードが増えた一方で、紹介経由が減っています。"],
        ["清水", "紹介は決まりやすいので、そこが減ったのは痛いですね。"],
        ["井上", "既存のお客様への働きかけが弱くなっている気がします。"],
        ["森", "定期的な接点を作る仕組みがないんですよね。"],
        ["井上", "四半期に一度でも、状況を伺う機会があるといいと思います。"],
        ["部長・松本", "それは次期の施策として入れましょう。担当は。"],
        ["井上", "私のほうで設計してみます。"],
        ["清水", "既存顧客のリストは私が整理して渡します。"],
        ["部長・松本", "お願いします。他に上げておくことはありますか。"],
        ["森", "採用が計画に対して遅れています。"],
        ["部長・松本", "そちらは人事と別途詰めましょう。"],
      ],
      35,
    ),
    // Deliberate gap: the meeting moves on and 高橋 never speaks again.
    m4Opening[m4Opening.length - 1].at + 4 * MIN,
    r4,
  );
  const m4 = [...m4Opening, ...m4Body];

  const seeds = [
    {
      id: "seed-product-priorities",
      title: "新機能の優先度すり合わせ",
      transcript: m1,
      note: {
        topics: [
          { text: "次期リリースに入れる機能の優先度", count: 4, firstSeen: now, lastSeen: now },
          { text: "検索の表記ゆれ対応", count: 5, firstSeen: now, lastSeen: now },
          { text: "モバイルでの表示崩れ", count: 3, firstSeen: now, lastSeen: now },
        ],
        decisions: [
          { text: "表記ゆれの辞書対応を今回のリリースに入れる", count: 3, firstSeen: now, lastSeen: now },
          { text: "全文検索基盤の入れ替えは次回リリースに回す", count: 2, firstSeen: now, lastSeen: now },
          { text: "モバイル修正の優先度を上げる", count: 2, firstSeen: now, lastSeen: now },
        ],
        actions: [
          { text: "佐藤がスケジュールを引き直して共有する", count: 3, firstSeen: now, lastSeen: now },
          { text: "中村が工数を確保する", count: 2, firstSeen: now, lastSeen: now },
        ],
        questions: [
          { text: "実装コストはどれくらいか", count: 2, firstSeen: now, lastSeen: now },
          { text: "段階的に進められないか", count: 2, firstSeen: now, lastSeen: now },
        ],
        keywords: [
          { text: "全文検索", count: 4, firstSeen: now, lastSeen: now },
          { text: "表記ゆれ", count: 5, firstSeen: now, lastSeen: now },
          { text: "電気ケトル", count: 2, firstSeen: now, lastSeen: now },
        ],
      },
    },
    {
      id: "seed-standup",
      title: "朝会",
      transcript: m2,
      note: {
        topics: [{ text: "各メンバーの進捗共有", count: 2, firstSeen: now, lastSeen: now }],
        decisions: [],
        actions: [
          { text: "伊藤がレビュー対応後にマージする", count: 1, firstSeen: now, lastSeen: now },
          { text: "渡辺が管理画面の不具合を今日中に修正する", count: 1, firstSeen: now, lastSeen: now },
        ],
        questions: [{ text: "ブロッカーはあるか", count: 1, firstSeen: now, lastSeen: now }],
        keywords: [{ text: "検索API", count: 1, firstSeen: now, lastSeen: now }],
      },
    },
    {
      id: "seed-discovery",
      title: "顧客ヒアリング（コールセンター導入）",
      transcript: m3,
      note: {
        topics: [
          { text: "コールセンターでの商品知識の属人化", count: 6, firstSeen: now, lastSeen: now },
          { text: "マニュアル検索が機能していない", count: 4, firstSeen: now, lastSeen: now },
        ],
        decisions: [{ text: "提案書を作成して提出する", count: 2, firstSeen: now, lastSeen: now }],
        actions: [{ text: "営業担当が費用感を含む提案書を送る", count: 2, firstSeen: now, lastSeen: now }],
        questions: [
          { text: "導入までどれくらいかかるか", count: 2, firstSeen: now, lastSeen: now },
          { text: "お客様の言い方のばらつきをどう吸収するか", count: 3, firstSeen: now, lastSeen: now },
        ],
        keywords: [
          { text: "コールセンター", count: 6, firstSeen: now, lastSeen: now },
          { text: "ファイルサーバー", count: 2, firstSeen: now, lastSeen: now },
          { text: "型番", count: 2, firstSeen: now, lastSeen: now },
        ],
      },
    },
    {
      id: "seed-quarterly",
      title: "四半期振り返り",
      transcript: m4,
      note: {
        topics: [
          { text: "四半期の売上着地と未達要因", count: 3, firstSeen: now, lastSeen: now },
          { text: "リードの質の低下", count: 5, firstSeen: now, lastSeen: now },
          { text: "既存顧客への定期的な接点づくり", count: 4, firstSeen: now, lastSeen: now },
        ],
        decisions: [
          { text: "既存顧客への定期接点を次期施策として実施する", count: 3, firstSeen: now, lastSeen: now },
          { text: "採用の遅れは人事と別途詰める", count: 2, firstSeen: now, lastSeen: now },
        ],
        actions: [
          { text: "井上が定期接点の仕組みを設計する", count: 3, firstSeen: now, lastSeen: now },
          { text: "清水が既存顧客リストを整理して渡す", count: 3, firstSeen: now, lastSeen: now },
        ],
        questions: [
          { text: "大型案件がずれ込んだ理由は何か", count: 2, firstSeen: now, lastSeen: now },
          { text: "流入経路のどこを見直すべきか", count: 3, firstSeen: now, lastSeen: now },
        ],
        keywords: [
          { text: "商談化率", count: 4, firstSeen: now, lastSeen: now },
          { text: "パイプライン", count: 3, firstSeen: now, lastSeen: now },
          { text: "紹介経由", count: 4, firstSeen: now, lastSeen: now },
        ],
      },
    },
  ];

  const results = [];
  for (const s of seeds) {
    const meeting = MeetingArchive.build(s);
    if (!meeting) {
      results.push(`${s.title}: SKIPPED (empty transcript)`);
      continue;
    }
    const saved = await MeetingArchive.save(meeting);
    const mins = Math.round((meeting.endedAt - meeting.startedAt) / 60000);
    results.push(
      `${saved.ok ? "OK" : "FAIL"} ${meeting.title} — ${meeting.transcript.length}行 / ` +
        `${meeting.speakers.length}名 / ${mins}分` +
        (saved.ok ? "" : ` (${saved.error})`),
    );
  }

    console.log("[samples] " + results.join("\n[samples] "));
    return results;
  }

  global.MeetingSamples = { seed };
})(self);
