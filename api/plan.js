// Vercel Serverless Function（依存パッケージなし・fetch直叩き）
// 環境変数 ANTHROPIC_API_KEY をVercelの設定画面で登録すること

export const config = { maxDuration: 60 };

const MODEL = "claude-haiku-4-5"; // ブースは速さ優先。品質を上げる時は "claude-sonnet-5" に変更

const SYSTEM_PROMPT = `あなたは「Lumia AI SCHOOL（女性のためのAIスクール）」のイベントブースで動く旅行プランナーAIです。
来場者（主に女性）の希望をもとに、その人だけの旅行プランをつくります。

# 出力ルール（絶対）
- 出力はJSONのみ。前置き・解説・コードブロック記号は一切つけない。
- 次の形式に従う:
{"title":"プランのタイトル（行き先と日数を含む・25字以内）","lead":"プランの紹介文1〜2文（60字以内）","days":[{"label":"1日目","theme":"その日のテーマ（10字以内）","items":[{"time":"午前","text":"..."},{"time":"ランチ","text":"..."},{"time":"午後","text":"..."},{"time":"夜","text":"..."}]}],"points":["旅のポイント3つ（持ち物・移動・予約のコツなど各40字以内）"]}

# 中身のルール
- daysの数は旅行日数に合わせる（1泊2日=2、2泊3日=3、3泊4日=4、4泊5日=5、1週間くらい=5日分+最終日のitemsに「残りの日はお気に入りの場所を再訪してゆったり」を含める）。
- 1日目は出発・到着・チェックインから。最終日はおみやげと帰国で締める。
- 実在する観光スポット名・料理名・エリア名を具体的に入れる（例:「観光」でなく「九份で提灯の街並みさんぽ」）。
- 同行者・予算・重視することに必ず寄り添う（子連れなら移動短め、贅沢感なら良いホテルとスパ、コスパなら屋台やフリースポット多め）。
- 「やりたいこと」「食べたいもの」は必ずどこかの日に組み込む。
- 文体は明るく上品に。絵文字は各textに多くて1個まで。誇張や「!!」の連発はしない。
- 各itemのtextは50字以内。読みやすく短く。`;

/* モデルの返答からJSONを取り出す。
   「はい、承知しました」のような前置きやコードブロック記号が付いてくることがあるので、
   そのまま JSON.parse せず、いくつかの候補を順に試す。 */
function extractPlan(data) {
  const raw = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");

  const candidates = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const i = raw.indexOf("{"), j = raw.lastIndexOf("}");
  if (i >= 0 && j > i) candidates.push(raw.slice(i, j + 1));
  candidates.push(raw.trim());

  for (const c of candidates) {
    try {
      const o = JSON.parse(c);
      if (o && Array.isArray(o.days) && o.days.length) return o;
    } catch { /* 次の候補を試す */ }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY が未設定です" });
  }

  const f = req.body || {};
  const clip = (v, n) => String(v ?? "").slice(0, n);
  const list = (v, n) => (Array.isArray(v) ? v : [v]).map(x => clip(x, 30)).slice(0, n).join("、");

  const userPrompt = `次の希望で旅行プランをつくってください。
- 旅タイプ診断の結果: ${clip(f.type, 20)}
- 行き先: ${clip(f.destination, 30)}
- 旅行時期: ${clip(f.when, 10)}
- 日数: ${clip(f.days, 10)}
- 同行者: ${clip(f.companions, 15)}（${clip(f.people, 6)}）
- 予算(1人): ${clip(f.budget, 10)}
- やりたいこと: ${list(f.wants, 6) || "おまかせ"}
- 食べたいもの: ${list(f.foods, 4) || "おまかせ"}
- 重視すること: ${clip(f.focus, 15) || "おまかせ"}`;

  const callModel = () => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      /* 1800だと4〜5日のプランで書き切れずに途中で切れることがあった。
         上限を上げても、実際に使った分しか課金されない */
      max_tokens: 4000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  try {
    /* たまたま1回失敗しただけで見本プランに落とさないよう、2回まで試す */
    let plan = null, lastData = null;
    for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
      const apiResponse = await callModel();
      if (!apiResponse.ok) {
        const t = await apiResponse.text();
        console.error("Anthropic API error:", apiResponse.status, t.slice(0, 300));
        return res.status(502).json({ error: `API ${apiResponse.status}` });
      }
      lastData = await apiResponse.json();
      plan = extractPlan(lastData);
      if (!plan) {
        console.error("parse failed (attempt " + attempt + ") stop_reason:",
                      lastData.stop_reason, "usage:", JSON.stringify(lastData.usage));
      }
    }
    if (!plan) {
      /* 原因調査用。body に __debug:"lumia" を入れたときだけ、モデルの返答をそのまま返す。
         調べ終わったらこのブロックは消してよい */
      if ((req.body || {}).__debug === "lumia") {
        const raw = (lastData.content || []).filter(b => b.type === "text").map(b => b.text).join("");
        return res.status(502).json({
          error: "parse",
          stop_reason: lastData.stop_reason,
          usage: lastData.usage,
          content_types: (lastData.content || []).map(b => b.type),
          raw_head: raw.slice(0, 600),
          raw_len: raw.length
        });
      }
      return res.status(502).json({ error: "parse" });
    }
    return res.status(200).json({ plan, usage: lastData.usage });
  } catch (err) {
    console.error("Function error:", err);
    return res.status(500).json({ error: err.message || "生成に失敗しました" });
  }
}
