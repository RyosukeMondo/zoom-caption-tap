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

  // ---------------------------------------------------------------------
  // 5. Sales call — the 商談フィードバック demo.
  //
  //    Deliberately shaped like a real, mediocre-but-not-disastrous call, so
  //    the feedback has something to actually say: it opens well with
  //    discovery questions, collapses into a long product monologue in the
  //    middle (which is what drags the talk ratio up and drops the customer's
  //    share in the second half), then recovers at the end by securing a next
  //    step. A flawless call would make the coaching panel look like
  //    decoration.
  // ---------------------------------------------------------------------
  const r5 = rng(5005);
  const m5Start = now - 2 * day + 15 * 60 * 60000;

  const m5Discovery = lay(
    [
      ["営業・佐々木", "本日はお時間をいただきありがとうございます。"],
      ["顧客・田村", "こちらこそ、よろしくお願いします。"],
      ["営業・佐々木", "早速ですが、現在の業務で一番お困りのところはどのあたりでしょうか。"],
      ["顧客・田村", "問い合わせ対応に時間がかかりすぎているところですね。"],
      ["顧客・田村", "一件あたりの対応時間が、平均で十五分ほどかかっています。"],
      ["営業・佐々木", "その十五分は、どのような内訳になっていますか。"],
      ["顧客・田村", "半分近くは調べる時間だと思います。"],
      ["顧客・岡田", "実際、マニュアルを探すだけで数分かかることもあります。"],
      ["営業・佐々木", "それは何名くらいの方が同じ状況でしょうか。"],
      ["顧客・岡田", "オペレーターが二十名ほどいますので、全員ですね。"],
      ["顧客・田村", "特に新人は、どこを見ればいいのかも分からない状態です。"],
      ["営業・佐々木", "なるほど。教育にも時間がかかってしまうということですね。"],
      ["顧客・田村", "そうなんです。育つまでに三ヶ月はかかります。"],
    ],
    m5Start,
    r5,
  );

  // The monologue. Consecutive seller lines with short gaps, long enough to
  // cross the 90s threshold and be flagged.
  const m5Pitch = lay(
    [
      ["営業・佐々木", "でしたら、弊社のサービスがお役に立てると思います。"],
      ["営業・佐々木", "まず、会話の内容をリアルタイムで解析する仕組みが入っています。"],
      ["営業・佐々木", "お客様が話された内容から、関連する社内文書を自動で提示します。"],
      ["営業・佐々木", "検索の操作は不要で、画面の横に候補が出てくる形です。"],
      ["営業・佐々木", "表記のゆれにも対応していまして、たとえば電気ポットと電気ケトルのような。"],
      ["営業・佐々木", "言い方が違っても同じ商品として扱えます。"],
      ["営業・佐々木", "導入の形としては、まず既存の文書を取り込んでいただきます。"],
      ["営業・佐々木", "その際、フォーマットが揃っていなくても問題ありません。"],
      ["営業・佐々木", "こちらで整形して、検索できる形に変換します。"],
      ["営業・佐々木", "ダッシュボードでは、対応時間の推移も確認できます。"],
      ["営業・佐々木", "どの案件に時間がかかっているかも一覧で見られます。"],
      ["営業・佐々木", "管理者の方向けに、レポート出力の機能もございます。"],
      ["営業・佐々木", "権限管理も細かく設定できますので、情報統制の面でも安心です。"],
      ["営業・佐々木", "他社様では、対応時間が三割ほど短縮した例もございます。"],
      ["営業・佐々木", "教育期間についても、短縮できたというお声をいただいています。"],
      ["営業・佐々木", "セキュリティ面では、データは国内のサーバーで管理しています。"],
      ["営業・佐々木", "外部への持ち出しも制限できる設計になっています。"],
      ["営業・佐々木", "運用開始後のサポートも、専任の担当がつきます。"],
      ["営業・佐々木", "月次で利用状況をご報告する形も可能です。"],
      ["営業・佐々木", "という形になっております。"],
    ],
    m5Discovery[m5Discovery.length - 1].at + 6000,
    r5,
    { sameMs: [3500, 6000] },
  );

  const m5Close = lay(
    [
      ["顧客・田村", "ありがとうございます。だいぶ分かりました。"],
      ["営業・佐々木", "何かご不明な点はございますか。"],
      ["顧客・岡田", "費用感はどれくらいになりますか。"],
      ["営業・佐々木", "規模によりますが、概算はお出しできます。"],
      ["顧客・田村", "社内で検討したいので、資料をいただけますか。"],
      ["営業・佐々木", "承知しました。では次回、お見積りとご提案書をお持ちします。"],
      ["営業・佐々木", "来週の後半で、ご都合のよい日程はございますか。"],
      ["顧客・田村", "木曜の午後であれば空いています。"],
      ["営業・佐々木", "ありがとうございます。では木曜日で調整いたします。"],
    ],
    m5Pitch[m5Pitch.length - 1].at + 4000,
    r5,
  );

  const m5 = [...m5Discovery, ...m5Pitch, ...m5Close];

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

  seeds.push({
    id: "seed-sales-call",
    title: "商談（コールセンター向け提案）",
    // Preselected so the feedback panel has something to show the moment the
    // sample loads — picking "which speaker am I" first would bury the demo.
    seller: "営業・佐々木",
    transcript: m5,
    note: {
      topics: [
        { text: "問い合わせ対応の所要時間", count: 5, firstSeen: now, lastSeen: now },
        { text: "マニュアル検索にかかる時間", count: 4, firstSeen: now, lastSeen: now },
        { text: "新人教育にかかる期間", count: 3, firstSeen: now, lastSeen: now },
      ],
      decisions: [
        { text: "見積書と提案書を次回持参する", count: 2, firstSeen: now, lastSeen: now },
        { text: "次回打ち合わせは木曜午後で調整する", count: 2, firstSeen: now, lastSeen: now },
      ],
      actions: [
        { text: "佐々木が見積りと提案書を作成する", count: 2, firstSeen: now, lastSeen: now },
        { text: "木曜午後で日程を調整する", count: 2, firstSeen: now, lastSeen: now },
      ],
      questions: [
        { text: "費用感はどれくらいか", count: 2, firstSeen: now, lastSeen: now },
        { text: "対応時間の内訳はどうなっているか", count: 2, firstSeen: now, lastSeen: now },
      ],
      keywords: [
        { text: "コールセンター", count: 4, firstSeen: now, lastSeen: now },
        { text: "表記ゆれ", count: 2, firstSeen: now, lastSeen: now },
        { text: "権限管理", count: 1, firstSeen: now, lastSeen: now },
      ],
    },
  });

  // ---------------------------------------------------------------------
  // A long 商談, built so the replay track has something to show.
  //
  // seed-sales-call is four minutes, which is under every realtime threshold
  // (90s monologue / 3min customer silence / 5min open-question drought /
  // 15min coverage reminder), so it demonstrates none of them. This one is
  // ~30 minutes and is laid out so each fires at a *different* point:
  //
  //   ~0-6min   discovery — 現状 / 課題 / 影響 get covered, open questions
  //   ~6-17min  a long pitch — monologue, customer silence, and then the
  //             open-question drought, all stacking up during it
  //   ~15min+   the coverage reminder, with 決裁 and 時期 still missing
  //   ~17min    「少し高い」 — talked over, never asked back: stays unresolved
  //   ~24min    「他社と比較」 — asked back within the window: resolves
  //   ~26min    予算 finally covered
  //
  // 決裁 and 時期 are deliberately never raised, so the checklist ends 4/6 and
  // the gap is the point of the sample rather than an oversight in writing it.
  const r6 = rng(6006);
  const m6Start = now - day + 10 * 60 * 60000;

  const m6Discovery = lay(
    [
      ["営業・佐々木", "本日はお時間をいただきありがとうございます。"],
      ["顧客・山本", "よろしくお願いします。"],
      ["営業・佐々木", "早速ですが、現在はどのように問い合わせ対応を運用されていますか。"],
      ["顧客・山本", "今は電話とメールを、五名ほどで回しています。"],
      ["営業・佐々木", "その中で一番お困りのところは、どのあたりでしょうか。"],
      ["顧客・山本", "問い合わせが集中する時間帯に、どうしてもお待たせしてしまいます。"],
      ["顧客・山本", "折り返しになることも多くて、そこが心苦しいところです。"],
      ["営業・佐々木", "お待たせしてしまうことで、どのような影響が出ていますか。"],
      ["顧客・山本", "解約の理由に挙げられたこともありますし、残業も増えています。"],
      ["営業・佐々木", "残業はどれくらい増えている感覚でしょうか。"],
      ["顧客・山本", "繁忙期だと、一人あたり月二十時間ほどでしょうか。"],
      ["営業・佐々木", "なるほど。人を増やすという話にはならないのでしょうか。"],
      ["顧客・山本", "募集はしているのですが、なかなか採用が進まないんです。"],
      ["顧客・山本", "採用できても、独り立ちまでに時間がかかりますし。"],
      ["営業・佐々木", "独り立ちまでは、どのくらいを見込まれていますか。"],
      ["顧客・山本", "三ヶ月は見ています。その間は先輩がつきっきりです。"],
    ],
    m6Start,
    r6,
  );

  // The pitch. Seller-only, with gaps under RUN_GAP_MS so the whole block reads
  // as one continuous run — long enough to trip the monologue warning, then the
  // customer-silence one, then the open-question drought, in that order.
  const m6Pitch = lay(
    expand(
      [
        ["営業・佐々木", "でしたら、弊社のサービスがお役に立てるかと思います。"],
        ["営業・佐々木", "会話の内容をその場で解析して、関連する社内文書を自動で出す仕組みです。"],
        ["営業・佐々木", "オペレーターが検索する手間そのものをなくす、という考え方になります。"],
        ["営業・佐々木", "表記の揺れも吸収しますので、言い回しが違っても拾えます。"],
        ["営業・佐々木", "権限に応じて、出す文書を出し分けることもできます。"],
        ["営業・佐々木", "導入いただいた他のセンター様では、一件あたりの対応が短くなっています。"],
      ],
      22,
    ),
    m6Discovery[m6Discovery.length - 1].at + 4000,
    r6,
    { sameMs: [6000, 9000] },
  );

  // The objection that gets talked over. The seller answers, but never with a
  // question, which is exactly what "unresolved" is meant to catch.
  // Long enough that the seller's next question falls outside
  // OBJECTION_WINDOW_MS — which is the whole point: the concern is answered
  // with assertions and never asked back about, so it stays unresolved.
  const m6Objection = lay(
    [
      ["顧客・山本", "正直なところ、少し高いと感じますね。"],
      ...expand(
        [
          ["営業・佐々木", "そう感じられる方は、はじめは多くいらっしゃいます。"],
          ["営業・佐々木", "ただ、対応が短くなれば残業のほうが先に減っていきます。"],
          ["営業・佐々木", "他社様と比べても、機能あたりでは割安なほうだと考えています。"],
          ["営業・佐々木", "サポートも標準で含まれていますので、追加の持ち出しはありません。"],
          ["営業・佐々木", "運用が乗るまでは、こちらで伴走もいたします。"],
          ["営業・佐々木", "設定も、はじめの作り込みまでこちらでお引き受けします。"],
        ],
        3,
      ),
      ["顧客・山本", "なるほど……。"],
    ],
    m6Pitch[m6Pitch.length - 1].at + 5000,
    r6,
    { sameMs: [7000, 9500] },
  );

  // The second objection, handled the way the first should have been.
  const m6Recover = lay(
    [
      ["顧客・山本", "実は他社さんとも比較していまして。"],
      ["営業・佐々木", "差し支えなければ、どのあたりを比べていらっしゃいますか。"],
      ["顧客・山本", "検索の精度と、あとは運用の手間ですね。"],
      ["営業・佐々木", "その二つは、どちらをより重く見ていらっしゃいますか。"],
      ["顧客・山本", "手間のほうです。入れたのに使われない、が一番怖いので。"],
      ["営業・佐々木", "承知しました。そこは実際の問い合わせで試していただくのが早いと思います。"],
      ["顧客・山本", "それは助かります。"],
    ],
    m6Objection[m6Objection.length - 1].at + 6000,
    r6,
  );

  const m6Close = lay(
    [
      ["営業・佐々木", "ご予算は、どれくらいをお考えでしょうか。"],
      ["顧客・山本", "年間で二百万円くらいまでなら、という感覚です。"],
      ["営業・佐々木", "ありがとうございます。その範囲で組める構成をお出しします。"],
      ["顧客・山本", "お願いします。"],
      ["営業・佐々木", "では、お見積りと提案書を作成して、次回お持ちします。"],
      ["顧客・山本", "はい、よろしくお願いします。"],
    ],
    m6Recover[m6Recover.length - 1].at + 5000,
    r6,
  );

  const m6 = [...m6Discovery, ...m6Pitch, ...m6Objection, ...m6Recover, ...m6Close];

  seeds.push({
    id: "seed-sales-call-long",
    title: "商談（長め・振り返り用）",
    seller: "営業・佐々木",
    transcript: m6,
    note: {
      topics: [
        { text: "問い合わせ集中時の待ち時間", count: 5, firstSeen: now, lastSeen: now },
        { text: "採用と教育にかかる期間", count: 3, firstSeen: now, lastSeen: now },
        { text: "他社サービスとの比較軸", count: 3, firstSeen: now, lastSeen: now },
      ],
      decisions: [
        { text: "実際の問い合わせで試用してもらう", count: 2, firstSeen: now, lastSeen: now },
        { text: "年間二百万円の範囲で構成を組む", count: 2, firstSeen: now, lastSeen: now },
      ],
      actions: [
        { text: "佐々木が見積りと提案書を作成する", count: 2, firstSeen: now, lastSeen: now },
      ],
      questions: [
        { text: "比較軸は検索精度と運用の手間のどちらが重いか", count: 2, firstSeen: now, lastSeen: now },
        { text: "残業はどれくらい増えているか", count: 2, firstSeen: now, lastSeen: now },
      ],
      keywords: [
        { text: "待ち時間", count: 4, firstSeen: now, lastSeen: now },
        { text: "残業", count: 3, firstSeen: now, lastSeen: now },
        { text: "他社比較", count: 3, firstSeen: now, lastSeen: now },
      ],
    },
  });

  const results = [];
  for (const s of seeds) {
    const meeting = MeetingArchive.build(s);
    if (!meeting) {
      results.push(`${s.title}: SKIPPED (empty transcript)`);
      continue;
    }
    const saved = await MeetingArchive.save(meeting);
    // Carried outside the record: which speaker is "me" is a coaching
    // preference, not part of the meeting itself.
    if (saved.ok && s.seller && global.MeetingCoach) {
      await MeetingCoach.setSeller(meeting.id, s.seller);
    }
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

  // Sample ids are all prefixed, which is what lets them be told apart from
  // real meetings (those get `m-<timestamp>` from MeetingArchive.build) without
  // adding a field to the stored schema. Detection stays correct even for
  // records written by an older version.
  const PREFIX = "seed-";

  function isSample(id) {
    return typeof id === "string" && id.startsWith(PREFIX);
  }

  /** Removes every sample meeting, leaving real ones untouched. */
  async function clear() {
    const all = await MeetingArchive.list();
    const samples = all.filter((m) => isSample(m.id));
    for (const m of samples) await MeetingArchive.remove(m.id);
    return samples.length;
  }

  async function count() {
    return (await MeetingArchive.list()).filter((m) => isSample(m.id)).length;
  }

  global.MeetingSamples = { seed, clear, count, isSample, PREFIX };
})(self);
