// Menu text & per-command help (English).
module.exports = {
  "menu.text": `
✨ *AGEMASEN BOT* ✨

Fufu... welcome, Trainer-san. Here's the list of available commands. For crypto analysis, just tag me or reply to my messages~

┏━━━━━━━━━━━━━━━┓
┃ 🔎 *IMAGE SEARCH*
┗━━━━━━━━━━━━━━━┛
▸ !img
▸ !pin
▸ !pixiv
▸ !next
▸ !id

┏━━━━━━━━━━━━━━━┓
┃ 🎞️ *GIF SEARCH*
┗━━━━━━━━━━━━━━━┛
▸ !gif

┏━━━━━━━━━━━━━━━┓
┃ 🏇 *UMA MUSUME*
┗━━━━━━━━━━━━━━━┛
▸ !trainer
▸ !club
▸ !threshold
▸ !leaderboard

┏━━━━━━━━━━━━━━━┓
┃ 🎨 *STICKERS*
┗━━━━━━━━━━━━━━━┛
▸ !meme
▸ !smeme
▸ !s
▸ !sbrat
▸ !gifbrat
▸ !schat
▸ !togif
▸ !toimg

┏━━━━━━━━━━━━━━━┓
┃ 📥 *MEDIA DOWNLOAD*
┗━━━━━━━━━━━━━━━┛
▸ !dl
▸ !dlr
▸ !dlt

┏━━━━━━━━━━━━━━━┓
┃ 🖼️ *AI UPSCALE*
┗━━━━━━━━━━━━━━━┛
▸ !hd

┏━━━━━━━━━━━━━━━┓
┃ 📄 *DOCUMENTS*
┗━━━━━━━━━━━━━━━┛
▸ !summarize
▸ !article

┏━━━━━━━━━━━━━━━┓
┃ 📈 *CRYPTO ANALYSIS*
┗━━━━━━━━━━━━━━━┛
▸ !analysis
▸ !chart
▸ !price
▸ !level
▸ !snr
▸ !fib
▸ !hhll
▸ !trenstate
▸ !pola
▸ !ema
▸ !movave
▸ !trend
▸ !mtf
▸ !bias
▸ !signal
▸ !compare
▸ !listcrypto
▸ !listforex
▸ !all
▸ !top
▸ !flop
▸ !categories
▸ !search
▸ !overview
▸ !stats
▸ !scan
▸ !scandivergent
▸ !watch
▸ !unwatch
▸ !watchlist
▸ !alert
▸ !levelalert
▸ !alertdivergent
▸ !alertind
▸ !alertsnr
▸ !alertsignal
▸ !alerthhll
▸ !alertpola
▸ !alertamd
▸ !alertdusdt
▸ !posisi
▸ !alerts
▸ !deletealert
▸ !daily
▸ !stopdaily
▸ !rate
▸ !convert
▸ !tf
▸ !dusdt

┏━━━━━━━━━━━━━━━┓
┃ 📰 *FOREX NEWS*
┗━━━━━━━━━━━━━━━┛
▸ !fxnews
▸ !fxcal

┏━━━━━━━━━━━━━━━┓
┃ 💬 *AI CHAT*
┗━━━━━━━━━━━━━━━┛
▸ Tag me (@AgemasenBot) to chat
▸ Or reply to my message to keep talking
▸ !forget

┏━━━━━━━━━━━━━━━┓
┃ ⚙️ *MISC*
┗━━━━━━━━━━━━━━━┛
▸ !groupinfo
▸ !online
▸ !botstatus
▸ !subscription
▸ !lang
▸ !ping
▸ !menu

━━━━━━━━━━━━━━━━━━

Not sure how to use a command? Just type it (even if it's wrong or incomplete) and I'll explain how it works myself.

...I-it's not like I care about you or anything. I just hate having the same question asked over and over.
`,

  "cmd.img": `🔎 *!img <tag>*

Search images by tag.
_(If the tag is too generic, you'll get a list of choices. Just reply with the number.)_

Every search result comes with a *Session Code* (a number). Anyone in the group can type that number to get another image from the same search -- it doesn't have to be the person who started it, and it won't get mixed up with other searches because each search has its own code.

*Examples:*
\`\`\`
!img special week
!img special week, silence suzuka
!img tokai_teio_(umamusume)
\`\`\`

You don't need to write the exact Safebooru tag: just type the name with spaces and a list of matching tags will appear -- reply with the number. If you type several characters, separate them with commas. The lists appear one by one, then an image containing all of them is sent. The old underscore style still works.

*Want more than 1 image?* Add *#count* at the very end (max 100, 10+ images are sent as a .zip file):
\`\`\`
!img special week #8
!img special week, silence suzuka #5
\`\`\`

"Uchiha" has way too many results... that's why you pick one of the numbers shown. Do I really have to explain something this obvious...`,

  "cmd.pin": `📌 *!pin <keyword>*

Search Pinterest images by keyword.

Just like *!img*, every search result comes with a *Session Code*. Anyone in the group can type that number (or *!next*) to get another image from the same search.

*Examples:*
\`\`\`
!pin sunset aesthetic
!pin cute cat
!pin minimalist bedroom design
\`\`\`

*Want more than 1 image?* Add *#count* at the very end (max 100, 10+ images are sent as a .zip file):
\`\`\`
!pin special week #8
!pin cute cat #5
\`\`\`
The Session Code appears on the last image.

⚠️ This uses Pinterest's internal search (not an official API), so it may occasionally fail or change without notice -- if that happens, try again in a bit.`,

  "cmd.pixiv": `🎨 *!pixiv <keyword>*

Search Pixiv illustrations by keyword. *Safe mode only* -- adult content (R-18 etc.) is filtered out automatically.

Just like *!pin*, every search result comes with a *Session Code*. Anyone in the group can type that number (or *!next*) to get another illustration from the same search.

*Examples:*
\`\`\`
!pixiv special week
!pixiv landscape
!pixiv 風景
\`\`\`

*Want more than 1 image?* Add *#count* at the very end (max 100, 10+ images are sent as a .zip file):
\`\`\`
!pixiv special week #8
!pixiv landscape #5
\`\`\`
The Session Code appears on the first image, together with the list of artwork links.

⚠️ This uses Pixiv's internal endpoint (not an official API), so it may occasionally fail or change without notice -- if that happens, try again in a bit.`,

  "cmd.gif": `🎞️ *!gif <keyword>*

Search GIFs (Tenor first, GIPHY as a fallback if Tenor fails/returns nothing) by keyword, then send 1 RANDOM result to the chat.

Just like *!img*/*!pin*, every search result comes with a *Session Code*. Anyone in the group can type that number (or *!next*) to get another GIF from the same search, without searching from scratch.

*Examples:*
\`\`\`
!gif special week uma
!gif anime reaction
!gif funny cat
\`\`\`

Case doesn't matter (*!GIF* works too), and extra spaces are cleaned up automatically.`,

  "cmd.next": `➡️ *!next*

Go to the next result of the same tag/keyword search (from *!img*, *!pin*, *!pixiv*, or *!gif*).

💡 Besides typing *!next*, you can also type the *Session Code* (the number shown in the result) -- anyone in the group can use it, not just whoever started the search.

⚠️ Use *!img <tag>*, *!pin <keyword>*, *!pixiv <keyword>*, or *!gif <keyword>* first before using this.`,

  "cmd.id": `🆔 *!id <code>*

Open a specific image again using its ID code.

*Example:*
\`\`\`
!id 12345
\`\`\``,

  "cmd.meme": `🎨 *!meme <text>*

Turn a GIF/video into an animated sticker with text.

*How to use:*
• Send a GIF/video with the caption \`!meme text\`.
• Or send the GIF/video first, then *reply* to it with \`!meme text\`.

Want two lines? Separate them with \`|\`. Want text on top only? Put a \`|\` after it (default is bottom). WhatsApp emoji work too.

*Example:*
\`\`\`
!meme HELLO WORLD|GOOD MORNING
!meme HELLO |
\`\`\`

(For stickers/photos, use *!smeme* instead)`,

  "cmd.smeme": `🎨 *!smeme <text>*

Turn a sticker (emote) or photo into a sticker with text.

*How to use:*
• Send a sticker/photo with the caption \`!smeme text\`.
• Or send the media first, then *reply* to it with \`!smeme text\`.

Want two lines? Separate them with \`|\`. Want text on top only? Put a \`|\` after it (default is bottom). WhatsApp emoji work too.

*Example:*
\`\`\`
!smeme lmaooooo😂
!smeme HELLO |
\`\`\`

(For GIFs/videos, use *!meme* instead)`,

  "cmd.s": `🎨 *!s*

Turn any GIF/video/sticker/photo into a regular sticker, without text.

*How to use:*
• Send the media with the caption \`!s\`.
• Or send the media first, then *reply* to it with \`!s\`.`,

  "cmd.sbrat": `🖤 *!sbrat <text>*

Turn text into a BRAT-style sticker (white background, black lowercase text in a narrow font, justified, with a "fried" blur effect) -- made purely from text, no media needed.

*How to use:*
Type the text right after the command.

*Examples:*
\`\`\`
!sbrat let's go let's go
!sbrat you only live once
!sbrat so tired today 😭
\`\`\`

💡 You can also use a dot: \`.sbrat your text\`.
💡 Emoji are allowed inside the text (including flags 🇮🇩 and skin-tone emoji 👍🏽), shown as emoji images.

⚠️ Maximum of about 80 characters to keep the sticker layout tidy.`,

  "cmd.gifbrat": `🖤 *!gifbrat <text>*

Make an animated BRAT-style STICKER that "types" word by word: words appear one at a time, and the font size and layout adjust with every new word until the full brat is shown (same result as !sbrat). Made purely from text, no media needed.

*How to use:*
Type the text right after the command.

*Examples:*
\`\`\`
!gifbrat let's go let's go
!gifbrat you only live once
!gifbrat so tired today 😭
\`\`\`

💡 You can also use a dot: \`.gifbrat your text\`.
💡 Emoji are allowed inside the text.

⚠️ Maximum of 30 words / 300 characters since every word becomes one animation frame.`,

  "cmd.schat": `💬 *!schat Name|Message|badge*

Turn text into a dark-mode WhatsApp style "chat dialog" sticker -- round avatar, then a dark bubble with the sender name, message, and time. Made purely from text, no media required.

*How to use:*
Type \`!schat Name|Message\` (the \`|badge\` part at the end is optional, usually a small emoji next to the name).

*The avatar is automatic, no need to upload anything:*
• *Reply* to someone's message in a group, then type \`!schat ...\` -> the avatar is THAT person's profile photo.
• *Tag* someone (@number) in the command text -> the avatar is the tagged person's profile photo.
• No reply/tag -> the avatar is YOUR own profile photo.
• Want to force an avatar from a specific image? Send an image/sticker with the caption \`!schat ...\`, or send the image first then *reply* with \`!schat ...\` -- this has the highest priority.
• If the photo can't be fetched (e.g. their WhatsApp privacy is closed), it automatically falls back to a colored circle with the initial.

*Examples:*
\`\`\`
!schat A.Z.A.N|go easy on the sarcasm please
!schat Budi|Hey, have you guys eaten yet?|😂
\`\`\`

💡 Want bold text? Wrap it in double asterisks: \`**bold**\`.

⚠️ Name max 40 characters, message max 500 characters (this limit is also re-checked in code -- see MAX_NAME_CHARS/MAX_MESSAGE_CHARS in dialogSticker.js).`,

  "cmd.togif": `🎞️ *!togif*

Turn an ANIMATED sticker back into a GIF (sent as a looping video, like a GIF).

*How to use:*
• Send the sticker with the caption \`!togif\`.
• Or send the sticker first, then *reply* with \`!togif\`.

⚠️ Animated stickers only. If the sticker is static (not animated), use *!toimg* instead.`,

  "cmd.toimg": `🖼️ *!toimg*

Turn a sticker into a regular image (PNG). If the sticker is animated, only the first frame is used.

*How to use:*
• Send the sticker with the caption \`!toimg\`.
• Or send the sticker first, then *reply* with \`!toimg\`.`,

  "cmd.dl": `📥 *!dl <link>*

Download video/audio from a link (or *reply* to a message with a link and type *!dl*): YouTube, Bilibili, Facebook (video/reel/video post), TikTok, Instagram, X/Twitter, and other supported sites.

If the link turns out to be a *photo* post (an Instagram carousel, or a TikTok photo+music slideshow), the bot automatically sends all the photos one by one, plus the music (if any) at the end. Or use *!dlr* directly if you already know the link is a photo/carousel.

*Examples:*
\`\`\`
!dl https://youtu.be/xxxxxxxxxxx
!dl https://youtu.be/xxxxxxxxxxx mp3
!dl https://www.tiktok.com/@user/video/xxxxxxxxxxx
!dl https://www.bilibili.com/video/xxxxxxxxxxx
!dl https://www.facebook.com/reel/xxxxxxxxxxx
!dl https://www.instagram.com/p/xxxxxxxxxxx
\`\`\`

You can add *mp3* or *mp4* after the link to override the audio/video format (default: video).

⚠️ File size limit is *200MB* (above ~90MB it is sent as a document). Default resolution is 720p; you can request *1080p* / *1440p* / *2160p* (4K), e.g. \`!dl <link> 1080p\`.

Want it sent as a *document* (full quality, no preview) or a regular *video*? Add *doc* or *video* at the end, e.g. \`!dl <link> 1080p doc\`. Default: regular video, automatically a document if the file is over ~90MB.`,

  "cmd.dlt": `🧵 *!dlt <link>*

Download a whole *thread* at once: all the post texts are combined in order (sent as text messages), then every photo/video is sent one by one. Works for X/Twitter threads, Threads (threads.net), and other sites supported by gallery-dl.

Same as *!dl <link> thread*. Threads links (threads.net/threads.com) are automatically treated as threads when you use plain *!dl*.

*Examples:*
\`\`\`
!dlt https://x.com/user/status/xxxxxxxxxxx
!dlt https://www.threads.net/@user/post/xxxxxxxxxxx
!dl https://x.com/user/status/xxxxxxxxxxx thread
\`\`\`

⚠️ Max *20 media* per thread, *95MB* limit per file. X/Twitter threads sometimes need cookies on the server (GALLERYDL_COOKIES_FILE).`,

  "cmd.dlr": `📷 *!dlr <link>*

Download *photo/carousel* posts only -- Instagram carousels (multiple swipeable photos) or TikTok photo+music/slideshow mode. All photos are sent one by one in their original order, then the music (if any) at the end.

Different from *!dl*: it goes straight to the photo route without trying video first -- faster if you already know the link is a carousel/photo slideshow (for regular videos/reels, keep using *!dl*).

*Examples:*
\`\`\`
!dlr https://www.instagram.com/p/xxxxxxxxxxx
!dlr https://www.tiktok.com/@user/video/xxxxxxxxxxx
\`\`\`

⚠️ File size limit is *95MB* per photo. Facebook posts that contain only PHOTOS (not video) are not supported -- this is purely for Instagram/TikTok.`,

  "cmd.ringkas": `📄 *!summarize [extra instructions]*

Summarize the main points of a PDF document using AI (Groq). Long documents (100+ pages) are automatically read section by section first and then combined into one summary, so everything gets covered -- not just the beginning.

*How to use:*
• Send a PDF file with the caption \`!summarize\`.
• Or send the PDF first, then *reply* with \`!summarize\`.
• You can add instructions after it, e.g. \`!summarize focus on the conclusion only\`.

*Examples:*
\`\`\`
!summarize
!summarize just explain the main points
\`\`\`

💡 After summarizing, you can ask more detailed questions about the document through normal chat (tag @AgemasenBot / reply to a bot message) for the next few hours -- the bot still "remembers" the full document, not just the summary.

⚠️ Only reads text that EXISTS in the PDF (scanned/photo PDFs without a text layer can't be read). Extremely long documents still have a hard limit, the rest is cut off.`,

  "cmd.artikel": `📚 *!article <keywords | DOI | URL>*

Search scholarly publications right from WhatsApp: title, authors, year, journal, DOI, citation count, and PDF links that are available *legally* (Open Access / arXiv).

*How to use:*
• *!article <keywords>* -> search publications (OpenAlex), then the DOI is matched via Crossref, a free PDF is checked via Unpaywall, and an arXiv version is looked up.
• *!article doi <DOI>* -> check metadata, citations, and PDF for a single DOI.
• *!article arxiv <keywords>* -> search preprints on arXiv.
• *!article <URL>* -> fetch a document from a public link (arXiv, DOAJ, Internet Archive, university repositories, OJS, or direct PDF links).

*Examples:*
\`\`\`
!article drone racing
!article doi 10.1000/xyz123
!article arxiv autonomous navigation
!article https://arxiv.org/abs/2101.00001
\`\`\`

💡 PDF status is split into *available*, *not found*, and *cannot be confirmed*. "Not found" does not guarantee there is no free version, and citation counts can differ between data providers.

⚠️ This bot INTENTIONALLY won't try to bypass paywalls, logins, CAPTCHAs, or DRM. Only links that are legally available are shown.`,

  "cmd.lupain": `🧠 *!forget*

Clear the AI chat memory between you and the bot -- including the PDF document memory from !summarize if there is one -- the bot will "forget" everything and start from scratch.

Image search commands (!img/!next/!id) are NOT affected, this only clears the AI chat memory.`,

  "cmd.lang": `🌐 *!lang [id|en]*

Switch the bot's language between *Bahasa Indonesia* and *English*.

*How to use:*
• *!lang* -> see the language currently in use.
• *!lang en* -> switch to English.
• *!lang id* -> switch to Bahasa Indonesia.

*Who does it apply to?*
• In a *DM*: the language is saved for your number only.
• In a *group*: the language is saved for the whole group, and only *group admins* (or the bot owner) can change it.

The setting is saved permanently, so it won't reset when the bot restarts.`,
  "cmd.trainer": "🏇 *!trainer <name or ID>*\n\nSearch Uma Musume trainers (uma.moe data). You get a list of trainers with similar names plus their IDs. *Reply* to that list with a number to see the trainer card (inheritance, factors, support card).\n\nIf you type a trainer ID (9-12 digits), the card is shown right away.\n\n*Example:*\n```\n!trainer azan\n!trainer 243028085654\n```",
  "cmd.club": "🏯 *!club <club name or ID>*\n\nSearch Uma Musume clubs (circles, uma.moe data). You get a list of clubs with similar names plus club ID and leader name. *Reply* to that list with a number to see the club card (stats, rank and each member\'s gain).\n\nIf you type a club ID (digits), the card is shown right away.\n\n*Example:*\n```\n!club hachimi\n!club 738117397\n```",
  "cmd.threshold": "📊 *!threshold*\n\nSends the Uma Musume circle rank threshold card from tier SS down to D (minimum fans, fans per day and deltas for each tier).\n\n*Example:*\n```\n!threshold\n```",
  "cmd.leaderboard": "🏆 *!leaderboard*\n\nSends the Uma Musume circle leaderboard card for rank 1 to 50 (tier, leader, live fans and monthly fans).\n\n*Example:*\n```\n!leaderboard\n!lb\n```",
  "cmd.analisis": "📈 *!analysis <coin> [15m|1H|4H|1D]*\n\nCrypto technical analysis (price, indicators, support/resistance, bullish/bearish scenarios, news, risks) sent as a *PDF file*.\n\n*Examples:*\n```\n!analysis btc\n!analysis sol 4h\n!analysis eth 1d\n```\n\nDefault timeframe is *4H*. Use the coin ticker (BTC, ETH, SOL, etc).\n\n⚠️ Automated analysis for education only, not trading signals. Takes about 10-40 seconds, with a 30-second cooldown between requests.",
  "cmd.chart": "🕯️ *!chart <coin> [15m|1H|4H|1D]*\n\nSends a candlestick chart image with EMA 20/50/200 lines, dashed support/resistance lines, *Fibonacci levels* (golden zone 0.5-0.618 shaded) and MACD/RSI/Dominance panels, plus a short *insight*: trend, momentum (RSI & MACD), nearest levels, Fibonacci position and a conclusion.\n\n*Examples:*\n```\n!chart btc 1d\n!chart sol\n```\n\nDefault timeframe is *4H*.",
  "cmd.harga": "💰 *!price <coin>*\n\nLive price in USDT and Rupiah with the 24h percent change.\n\n*Example:*\n```\n!price eth\n```",
  "cmd.level": "📊 *!level <coin> [15m|1H|4H|1D]*\n\nResistance (R1, R2) and support (S1, S2) levels with the percent distance from the current price.\n\n*Example:*\n```\n!level sol 4h\n```\n\nDefault timeframe is *4H*. Not financial advice.",
  "cmd.snr": "📐 *!snr <coin> [15m|1H|4H|1D]*\n\nFull Support & Resistance: the 3 nearest resistances (R1-R3) and supports (S1-S3), percent distance from the current price, each level's *strength* (how many times price reversed at that zone), plus the chart image.\n\n*How to read it:*\n🔴 R = resistance (ceiling, price tends to stall)\n🟢 S = support (floor, price tends to bounce)\n●●●○○ = level strength. Filled dots (●) = strength, empty dots (○) = unfilled slots, not a bad signal\n(6x) = price reversed at that level 6 times\nScale: 1x weak, 2-4x medium, 5-8x strong, 9x+ very strong\n\n*Examples:*\n```\n!snr btc\n!snr sol 1h\n!snr all eth\n```\n\n*!snr all <coin>* = all timeframes (15m, 1H, 4H, 1D) at once, sent as a single PDF (4-column table + chart per timeframe).\n\nDefault timeframe is *4H* (or whatever you set with !tf). Alias: !sr. Not financial advice.",
  "cmd.fib": "📐 *!fib <coin> [15m|1H|4H|1D]*\n\nAutomatic Fibonacci retracement + extension. The bot finds the swing high & swing low of the last 120 candles, then draws the fib *following the trend*: uptrend is drawn from swing low to swing high, downtrend from swing high to swing low. You get the list of levels, each one's percent distance from the current price, plus the chart image.\n\n*Levels:*\n▫️ Retracement: 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1 (areas where price may stall during a pullback)\n⭐ 0.5 & 0.618 = golden zone\n🎯 Extension: 1.272, 1.618, 2.0, 2.618 (targets if the trend continues)\n\n*Examples:*\n```\n!fib btc\n!fib sol 1h\n!fib all eth\n```\n\n*!fib all <coin>* = all timeframes (15m, 1H, 4H, 1D) at once, sent as a single PDF (4-column table + chart per timeframe).\n\nDefault timeframe is *4H* (or whatever you set with !tf). Aliases: !fibo, !fibonacci. Not financial advice.",
  "cmd.listkripto": "📋 *!listcrypto [keyword]*\n\nCoins available for !price, !chart, !level, and !analysis, grouped by category.\n\n*Examples:*\n```\n!listcrypto\n!listcrypto meme\n!listcrypto sol\n```\n\nOptional keyword: category, ticker, or coin name.",
  "cmd.listforex": "💱 *!listforex [keyword]*\n\nForex pairs supported by the bot, grouped by category (Major, Cross, Metal, Exotic). These pairs work with !signal, !pattern, !alertsignal, !alertpola, and !top / !flop forex.\n\n*Examples:*\n```\n!listforex\n!listforex jpy\n!listforex gold\n!listforex cross\n```\n\nOptional keyword: category, currency code (usd, jpy, eur), ticker, or name. Alias: !listfx.",
  "cmd.ema": "📐 *!ema <coin> [15m|1H|4H|1D]*\n\nEMA 20, 50, 200 values and where the price sits against each one (above / below).\n\n*Example:*\n```\n!ema bnb 4h\n```\n\nDefault timeframe is *4H*. Not financial advice.",
  "cmd.movave": "📊 *!movave <coin> [15m|1H|4H|1D] [sma|ema]*\n\nMoving Average: *SMA* and *EMA* values for periods 20, 50, 200, where the price sits against each one (above / below + distance %), any recent golden / death cross between MA 50 and MA 200, plus a short conclusion.\n\n*Example:*\n```\n!movave btc\n!movave sol 1h\n!movave eth 4h ema\n```\n\nAdd *sma* or *ema* to show only one of them. Default timeframe is *4H* (or whatever you set with !tf). Aliases: !ma, !movingaverage. Not financial advice.",
  "cmd.tren": "🧭 *!trend <coin> [15m|1H|4H|1D]*\n\nTrend status: bullish, bearish, or sideways. Mentions a golden cross / death cross if one just happened.\n\n*Example:*\n```\n!trend xrp 4h\n```\n\nDefault timeframe is *4H*. Not financial advice.",
  "cmd.mtf": "🗂️ *!mtf <coin>*\n\nMulti-timeframe summary (15m, 1H, 4H, 1D) in one table so you can see how the trends line up.\n\n*Example:*\n```\n!mtf btc\n```\n\nColumns: timeframe, trend, position vs EMA 200, nearest level. Not financial advice.",
  "cmd.bias": "📊 *!bias <coin> [15m|1H|4H|1D|all]*\n\nDirectional bias (bullish / neutral / bearish) per timeframe from combined indicators: EMA trend, crossovers, RSI, MACD, market mood, and BTC trend. Calculated directly, no AI.\n\n*Examples:*\n```\n!bias btc\n!bias eth 4h\n!bias sol all\n```\n\nNo timeframe = all (15m, 1H, 4H, 1D). Columns: bias, score (-1 to +1), and confidence (how many components agree). With more than one timeframe there is a *Total* row: the overall bias from a weighted average across timeframes (higher timeframes weigh more). Components without data (e.g. OI/funding) are marked N/A, not counted as zero.\n\nIt also shows a *bull/bear/sideways probability* (always sums to 100%), calculated from the same indicator score, not an AI-made number. It is an estimate, not a guarantee.\n\nThis is the current market condition, not an entry signal. For education only, based on technical indicators. Not a call to buy or sell.",
  "cmd.sinyal": "🎯 *!signal <coin> [15m|1H|4H|1D|all]*\n🎯 *!signal all [15m|1H|4H|1D]*\n\nEntry, stop loss (SL), take profit (TP1/TP2) and risk:reward (RR) scenarios for 15m, 1H, 4H and 1D in one message. Calculated directly from indicators, no AI. The direction (LONG/SHORT) follows *!bias* on each timeframe.\n\n*Examples:*\n```\n!signal btc\n!signal eth 4h\n!signal sol all\n```\n\n*Forex* (pairs are detected automatically, eurusd / eur/usd both work):\n```\n!signal eurusd\n!signal xauusd 4h\n!signal usdjpy all\n```\nPairs: EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, USDCAD, NZDUSD, EURGBP, EURJPY, GBPJPY, XAUUSD, USDIDR (from 1H). Alias: !fxsignal. SL/TP distances are shown in *pips*. No market mood, BTC trend, or volume. On weekends (market closed) entry status will never be VALID. Reference market price, not a broker quote. A single timeframe also sends the AMD chart, like crypto. Not available for forex yet: !signal all. Forex alerts: !alertsignal eurusd 1h.\n\n*All coins at once:*\n```\n!signal all\n!signal all 4h\n!signal all 1h 4h\n```\n*Status filter* (the PDF only contains what you pick):\n```\n!signal all valid\n!signal all wait\n!signal all avoid\n!signal all valid 4h\n!signal all valid wait 1h 4h\n```\n*invalid* / *avoid* = avoid status (sideways also works: !signal all sideways). Filters can be combined with timeframes, any order.\n\n!signal all = a *PDF* with tables of which coins are *valid* and which are not (wait / avoid with reasons, sideways) for *every coin on every timeframe*. Add timeframes (e.g. !signal all 4h) to include only the ones you pick. Validity is judged by the Sudden Move Guard, exactly like !signal <coin>. This is heavy: it can take 1–2 minutes and results are cached for 3 minutes.\n\nNo timeframe = all (15m, 1H, 4H, 1D). When the bias is neutral you get a *sideways* scenario instead: the upper/lower range bounds and the range-exit conditions (based on candle closes). Entry and SL come from closed candles, ATR 14 and swing support/resistance levels; RR is calculated from the entry/SL/TP numbers. A timeframe that goes against the overall bias is flagged as counter-trend.\n\nIt also shows a *bull/bear/sideways probability* (always sums to 100%), calculated from the same indicator score, not an AI-made number. It is an estimate, not a guarantee.\n\n*AMD (Accumulation – Manipulation – Distribution, \"Power of 3\")* is checked on every timeframe too: the pattern where big players build positions, trap retail traders, then push price in the real direction.\n🟦 *Accumulation*: price moves sideways in a tight range, both edges get touched.\n🟨 *Manipulation*: a wick pokes through the range high/low (sweep / stop hunt) and the candle *closes back inside the range*.\n🟩🟥 *Distribution*: after the sweep, the first close that breaks the opposite swing (market structure break, like in !hhll).\n• A sweep *below* the range then up = *bullish*. A sweep *above* the range then down = *bearish*.\n• A close that stays outside the range = a real breakout, not a trap. A close beyond the sweep extreme also voids the pattern.\n\nEach timeframe gets one AMD status line under its scenario. If you pick a *single timeframe* (e.g. !signal btc 4h), the bot first sends the *AMD chart* + the full phase explanation (range, confirmation level, invalidation), then the signal scenario. If the AMD direction goes against the LONG/SHORT scenario, it is flagged.\n\nAliases: !sinyal, !amd, !powerof3, !po3. Want automatic notifications? Use !alertsignal (signal scenarios) or !alertamd (AMD pattern).\n\nThis is an educational scenario from technical indicators, not a call to buy or sell and not a guarantee.",
  "cmd.bandingkan": "⚔️ *!compare <coin1> <coin2>*\n\nCompares two coins side by side: price, % change, trend, and position against the EMAs, with a short verdict on which one is stronger.\n\n*Example:*\n```\n!compare sol eth\n```\n\nUses your default timeframe (initially *4H*). Not financial advice.",
  "cmd.semua": "📊 *!all [category] [15m|1H|4H|1D]*\n\nList of all coins with price and % change. Results are paginated (25 coins per page), type *!next* for the next page.\n\n*Examples:*\n```\n!all\n!all layer1\n!all meme 1h\n```\n\n% change follows the timeframe (your default, initially *4H*). Category is optional, see the list with *!categories*. Not financial advice.",
  "cmd.top": "🚀 *!top [count] [all|crypto|forex]*\n\nTop 24h gainers: biggest risers.\nPick a scope: *all* (default, crypto on top then forex below), *crypto*, or *forex*.\n\n*Examples:*\n```\n!top\n!top 5\n!top crypto\n!top 5 forex\n```\n\nDefault 10, max 25. Not financial advice.",
  "cmd.flop": "📉 *!flop [count] [all|crypto|forex]*\n\nTop 24h losers: biggest fallers.\nPick a scope: *all* (default, crypto on top then forex below), *crypto*, or *forex*.\n\n*Examples:*\n```\n!flop\n!flop 5\n!flop crypto\n!flop 5 forex\n```\n\nDefault 10, max 25. Not financial advice.",
  "cmd.kategori": "🗂️ *!categories*\n\nShows the coin categories and how many coins each has. The filter word can be used with *!all*.\n\n*Example:*\n```\n!categories\n```",
  "cmd.cari": "🔍 *!search <name>*\n\nSearch coins by name or ticker (partial match).\n\n*Examples:*\n```\n!search sol\n!search bit\n```\n\nResults show ticker and coin name. Check the price with *!price <ticker>*.",
  "cmd.ringkasan": "🌐 *!ringkasan [15m|1H|4H|1D]*\n\nMarket overview: market mood, how many coins are above/below EMA 200, and BTC status.\n\n*Examples:*\n```\n!ringkasan\n!ringkasan 1h\n```\n\nNo timeframe = compact table of all 4 TFs (15m, 1H, 4H, 1D). With a timeframe = only that TF. Mood is *bullish* when ≥60% of coins are above EMA 200, *bearish* at ≤40%, otherwise neutral. Coins with too little data (<200 candles) are skipped and counted in a note, not treated as sideways. Not financial advice.",
  "cmd.stat": "📊 *!stat [15m|1H|4H|1D]*\n\nQuick stats: number of bullish vs bearish vs sideways coins, plus how many are above/below EMA 50 and EMA 200.\n\n*Examples:*\n```\n!stat\n!stat 4h\n```\n\nNo timeframe = compact table of all 4 TFs. With a timeframe = only that TF. Coins with too little data (<200 candles) are skipped and noted separately. Not financial advice.",
  "cmd.scandivergent": "🔀 *!scandivergent [coin] [15m|1H|4H|1D] [rsi|macd]*\n\nFinds coins that just formed a divergence between price and RSI or the MACD histogram.\n\n*No arguments* = all coins, all four timeframes (15m/1H/4H/1D), RSI + MACD, regular + hidden, bullish + bearish.\n\n*Examples:*\n```\n!scandivergent\n!scandivergent 4h\n!scandivergent 1h rsi\n!scandivergent macd\n!scandivergent zec 15m\n!scandivergent btc 4h rsi\n```\n\n*With a coin name* = one chart image (price + MACD + RSI). Blue arrows mark pivot 1 → pivot 2 with the change in price and RSI/MACD value. No timeframe = your default (!tf).\n\n*Result:* grouped by timeframe (1D > 4H > 1H > 15m), then Bullish and Bearish: coin, indicator, type. A few signals are shown as a short text; many signals are sent as one PDF.\n\n*Types:*\n• Regular = potential reversal (bullish: price lower low, indicator higher low)\n• Hidden = potential trend continuation (bullish: price higher low, indicator lower low)\n\nExtra filters (optional): bull/bear and regular/hidden, e.g. `!scandivergent bull 4h regular`.\n\n⚠️ Closed candles only. Pivots need 4 confirmation candles, so signals appear shortly after the peak/trough. Scan results are not predictions. Educational, not investment advice.",
  "cmd.scan": "🔎 *!scan <condition> [15m|1H|4H|1D]*\n\nScreener: finds coins that meet a given condition.\n\n*Conditions:*\n• diatas_ema200 / dibawah_ema200 (above / below EMA 200; above_ema200 / below_ema200 also work)\n• dekat_support / dekat_resistance (within 2%; near_support / near_resistance also work)\n• golden_cross / death_cross (EMA 50/200, within the last 10 candles)\n• breakout / breakdown (close beyond the previous 20 candles' high/low)\n• div_bull / div_bear (RSI/MACD divergence, see !scandivergent)\n\n*Examples:*\n```\n!scan dekat_support 4H\n!scan golden_cross 1D\n!scan div_bull 4H rsi\n```\n\nReturns a list of coins + price + distance to the level (max 25). No timeframe = your default. Not financial advice.",

  // ---------- watchlist & alert (Bagian 5) ----------
  "cmd.watch": "👀 *!watch <coin> [more coins ...]*\n\nAdds one or more coins to your personal watchlist (max 300 coins per watchlist, max 50 coins per command).\n\n*Examples:*\n```\n!watch SOL\n!watch BTC ETH SOL\n!watch all\n```\n*!watch all* adds every supported coin as long as it fits within the watchlist limit. The reply itemises coins added, already present, over the limit, and not recognised. See the full list with *!watchlist* (PDF).\n\nSee it with *!watchlist*.",
  "cmd.unwatch": "👀 *!unwatch <coin>*\n\nRemoves a coin from your personal watchlist.\n\n*Example:*\n```\n!unwatch SOL\n```",
  "cmd.watchlist": "📋 *!watchlist [pdf]*\n\nShows your whole watchlist: price, 24h % change, and trend status (uses your default timeframe, initially *4H*). With more than 20 coins the result is sent as a *PDF* so every coin fits at once. Add *pdf* to force a PDF even for a short list.\n\n*Examples:*\n```\n!watchlist\n!watchlist pdf\n```\n\nNot financial advice.",
  "cmd.alert": "🔔 *!alert <coin> <price>*\n\nCreates a price alert. The bot messages you when the price touches or breaks that number. Direction (up/down) is set automatically from the current price. The alert is removed once it fires.\n\n*Example:*\n```\n!alert SOL 100\n```\n\nSee active alerts with *!alerts*.",
  "cmd.alertlevel": "🔔 *!levelalert <coin>*\n\nAutomatic alert when price gets close (≤ 0.5%) to or touches the nearest support/resistance level. Levels are recalculated regularly using your default timeframe (initially *4H*), so this alert stays active until you delete it.\n\n*Example:*\n```\n!levelalert SOL\n```",
  "cmd.alertind": "🔔 *!alertind <coin|watchlist> [15m|1H|4H|1D] [bias|cross] [live]*\n\nAutomatic alert when the *bias changes* (bullish/neutral/bearish, from the !bias score) or a *new EMA crossover* appears (golden/death, 20/50 and 50/200). Alias: *!alertindicator*. New divergences use *!alertdiv*.\n\n*Examples:*\n```\n!alertind btc 4h\n!alertind btc 1h bias\n!alertind eth 4h cross\n!alertind watchlist 1h\n!alertind btc 15m live\n```\nNo bias/cross = both; no timeframe = your default (!tf).\n\n*Manage:*\n```\n!alertind list\n!alertind delete a1\n!alertind off\n```\n\n• Default = *closed candle*: checked on every candle close, signals are final.\n• *live* = recalculated periodically using the candle that has NOT closed yet. Every message is marked ⏳; a signal can change or vanish before the candle closes. A bias change must be seen several times in a row, and there is a minimum gap between alerts per coin.\n• Only NEW events after the alert was created; the first evaluation is the reference. Each event is announced once.\n• Alerts go to the chat where you created them (you are tagged in groups). Many events are combined in one message.\n• Not available for all coins yet (too heavy); use a specific coin or the watchlist.\n• The alert's bias score uses the coin's own components (trend, cross, RSI, MACD), so it can differ slightly from !bias, which also uses market mood and BTC.\n\n⚠️ Not a prediction. Educational, not investment advice.",
  "cmd.alertsnr": "🔔 *!alertsnr <coin|watchlist> [15m|1H|4H|1D] [reject|break|wick|sweep] [strong]*\n\nAutomatic alert when price reaches a Support/Resistance level (from !snr) and is then *rejected* or *breaks through*. Alerts are only sent as ✅ *confirmed*, i.e. after the candle has closed.\n\n*Examples:*\n```\n!alertsnr btc 4h\n!alertsnr btc 4h reject\n!alertsnr eth 1h break\n!alertsnr btc 4h strong\n!alertsnr watchlist 1h\n```\nNo kind keyword = reject + break; no timeframe = your default (!tf).\n\n*Optional (must be written, not part of the default):*\n```\n!alertsnr btc 1h wick sweep\n```\n• *wick*: a long wick (≥60% of range, small body) enters the level zone and is rejected.\n• *sweep* (alias fakeout): price sweeps the level then closes back on its original side; only announced on the candle that just closed.\n• If one candle matches several kinds at the same level, only one message is sent (sweep > wick > reject). Break stays separate.\n\n*Manage:*\n```\n!alertsnr list\n!alertsnr delete s1\n!alertsnr off\n```\n\n• *Reject*: price touches resistance and falls back, or touches support and bounces back.\n• *Break*: price leaves the level zone, upward for resistance, downward for support.\n• Levels use the !snr zones from previous closed candles, with a small band (±0.1%) around each level. Price that stays inside the band is not counted yet.\n• Default is the nearest levels only (R1/S1). Add *strong* for R1-R3/S1-S3 that were tested at least 5 times.\n• Situations that already exist when the alert is created are not announced; only what happens afterwards. Each event is announced once.\n• Alerts go to the chat where you created them (you are tagged in groups). Not available for all coins yet (too heavy); use a specific coin or the watchlist.\n\n⚠️ Not a prediction. Educational, not investment advice.",
  "cmd.alertsignal": "🔔 *!alertsignal <coin|watchlist> [15m|1H|4H|1D] [long|short] [wait]*\n\nAutomatic alert that sends the *signal scenario* like !signal (entry, SL, TP1/TP2, RR, entry status) when a LONG or SHORT scenario *newly appears* on a closed candle. Alias: *!alertsinyal*, *!alertfxsignal*. *Forex*: pairs are recognised automatically (!alertsignal eurusd 1h, !alertsignal eur/usd 4h long, !alertsignal xauusd 4h). SL/TP in pips; nothing is sent on weekends (market closed) because the entry status is never VALID. Watchlist is crypto only.\n\n*Examples:*\n```\n!alertsignal pepe 15m\n!alertsignal btc 4h long\n!alertsignal eth 1h wait\n!alertsignal watchlist 1h\n```\nNo long/short = both directions; no timeframe = your default (!tf).\n\n*Manage:*\n```\n!alertsignal list\n!alertsignal delete g1\n!alertsignal off\n```\n\n• Judged on the *closed candle*: the scenario is sent when the candle closes and it did not exist on the previous candle. While the same scenario persists, it is not sent again.\n• Default is only ✅ *VALID* entry status. Add *wait* to also get ⏳ WAIT. ⛔ AVOID and sideways are never sent.\n• Scenarios that already exist when the alert is created are not announced; only ones that appear afterwards. Each event is announced once.\n• Alerts go to the chat where you created them (you get tagged in groups). Several scenarios at once are combined into one message.\n• Not available for all coins (too heavy); use a specific coin or the watchlist.\n• The alert's bias score excludes market mood and BTC (same as !alertind), so it can differ slightly from a manual !signal.\n\n⚠️ Educational scenario from indicators, not a buy/sell call and not a guarantee.",
  "cmd.posisi": "📌 *!posisi buka <coin> [15m|1H|4H|1D] <long|short> entry <price> sl <price> [tp <price>]*\n\nTrack a position you have *already opened* so the bot watches it and sends a *WASPADA* (caution) or *CUT* alert when things get worse (price moving against you, an opposing wick/sweep at a level, a volume spike, a fast move, a close through your SL). Positions are registered manually: the bot cannot know whether you really entered at that price.\n\n*Examples:*\n```\n!posisi buka btc 1h long entry 98200 sl 97150\n!posisi buka eth 4h short entry 3450 sl 3560 tp 3200\n```\nPlain numbers, a dot for decimals, no thousands separators. No timeframe = your default (!tf). No tp = TP1 at 1.5R.\n\n*Manage:*\n```\n!posisi list\n!posisi sl p1 98200\n!posisi tp p1 99800\n!posisi tutup p1\n!posisi tutup semua\n```\n• *sl*: the SL may only move in the profit direction (LONG up, SHORT down). Widening is refused.\n• *tp*: change the TP target (must be on the profit side of the entry).\n• *tutup*: the bot stops watching. Your position on the exchange is *not* closed.\n\n*Price-based TP/SL:* the bot alerts when price is *approaching* the TP or SL (remaining distance ≤ 20% of the entry-to-level distance) and confirms when the price or a candle high/low *touches* the level. Once the TP/SL is touched, the position is removed from monitoring automatically. Example: `!posisi buka btc 1h long entry 81000 sl 80000.01 tp 81798.01`.\n\n*Sending rules:* WASPADA at most once per candle, CUT once per position, break-even and time-stop hints once. Plain info is not sent. The bot only sends messages; periodic polling can miss spikes, and real execution can slip past your SL. Alias: !position.\n\n⚠️ Not a prediction. Educational, not investment advice.",
  "cmd.hhll": "📊 *!hhll <coin> [15m|1H|4H|1D]*\n\nMarket structure: the bot finds the price turning points (swings) and labels them *HH, HL, LH, LL*, plus a chart.\n\n*How to read it:*\n🔺 HH = Higher High (peak above the previous peak)\n🟢 HL = Higher Low (trough above the previous trough)\n🔻 LH = Lower High (peak below the previous peak)\n🔴 LL = Lower Low (trough below the previous trough)\n\n• HH + HL = *uptrend structure* (healthy uptrend)\n• LH + LL = *downtrend structure*\n• Mixed = no clear direction (sideways / transition)\n• A close above the last swing high = breaks up (a sign the trend may turn up). A close below the last swing low = breaks down.\n\n*Examples:*\n```\n!hhll btc\n!hhll sol 1h\n```\n\nSwings come from closed candles and only count as confirmed after a few more candles have closed after them. Default timeframe is *4H* (or whatever you set with !tf). Alias: !struktur. Want automatic alerts? Use !alerthhll. Not financial advice.",
  "cmd.alerthhll": "🔔 *!alerthhll <coin|watchlist> [15m|1H|4H|1D] [up|down] [early|confirmed] [reversal]*\n\nAutomatic alert when price structure changes (Higher High / Lower Low), judged from closed candles. Handy to get told when a coin starts moving up.\n\n*Examples:*\n```\n!alerthhll btc 4h\n!alerthhll eth 1h up down\n!alerthhll sol 4h confirmed\n!alerthhll watchlist 1h reversal\n```\nWithout up/down = *up* only; write both for two directions. Without early/confirmed = both. Without a timeframe = your default (!tf).\n\n*Manage:*\n```\n!alerthhll list\n!alerthhll delete h1\n!alerthhll off\n```\n\n• 👀 *Early*: a new swing formed but nothing broke yet. Up = *new HL* (higher trough) while the structure was not up before. Down = *new LH*.\n• ✅ *Confirmed*: the first close that *breaks the last swing high* for up, or the last swing low for down.\n• *reversal*: only events that flip direction (for example from down/sideways to up); trend continuations are skipped.\n• Conditions that already exist when the alert is created are not announced; only what happens afterwards. Each event is announced once.\n• Many events at once (for example a long watchlist) are sent as 1 PDF per recipient, grouped by timeframe.\n• Not available for all coins yet (too heavy); use a specific coin or your watchlist.\n\n⚠️ Not a prediction. Educational, not investment advice.",
  "cmd.alertamd": "🔔 *!alertamd <coin|watchlist> [15m|1H|4H|1D] [up|down] [early|confirmed] [rr<tp1>:<tp2>] [sl <price>] [tp <price>]*\n\nAutomatic alerts for the AMD pattern (Accumulation – Manipulation – Distribution), judged from closed candles.\n\n*Examples:*\n```\n!alertamd btc 4h\n!alertamd eth 1h up\n!alertamd sol 4h down confirmed\n!alertamd watchlist 1h early\n!alertamd btc 4h rr2:4\n!alertamd btc 4h up sl 97150 tp 99800\n```\nNo up/down = *both directions* (bullish and bearish). No early/confirmed = both. No timeframe = your default (!tf).\n\n*SL/TP:* every notification is a *chart image* with an automatic SL/TP plan. SL sits beyond the sweep extreme (plus a small ATR buffer); TP1 and TP2 are multiples of the SL distance (R). Entry: the closing price at confirmation, or the structure-break level for early alerts. Default TP is 1.5R and 3R; change it with rr, e.g. rr2:4 (TP1 2R, TP2 4R) or rr2 (TP1 2R, TP2 4R automatically). Re-send the command with a new rr to change an existing alert.\n\n*Price-based SL/TP:* add `sl <price>` and/or `tp <price>` to use your own levels instead of the automatic ones. Requires *one coin* and *one direction* (up = long, down = short); not allowed with the watchlist or rr. You can leave one out (the missing one stays automatic). When the *confirmed* signal arrives, the position is tracked automatically like !posisi: you get a warning as price nears / hits TP or SL (check with !posisi list). Use a decimal point, no commas.\n\n*Manage:*\n```\n!alertamd list\n!alertamd delete a1\n!alertamd off\n```\n\n• 👀 *Early*: a *sweep* happened at an edge of the accumulation range (a wick pokes through, then closes back inside). Not confirmed yet, it can fail.\n• ✅ *Confirmed*: the first close after the sweep that *breaks the opposite swing* (up: above the swing high, down: below the swing low). That marks the start of distribution.\n• If price instead closes beyond the sweep extreme, the pattern fails and no confirmation is sent.\n• Conditions that already exist when the alert is created are not announced; only what happens afterwards. Each event is announced once.\n• Not available for all coins (too heavy); use a specific coin or your watchlist.\n\n⚠️ Not a prediction. Educational, not investment advice.",
  "cmd.alertdivergent": "🔔 *!alertdivergent <coin|all|watchlist> [15m|1H|4H|1D] [rsi|macd] [bull|bear] [regular|hidden] [early]*\n\nAutomatic alert when a NEW divergence forms between price and RSI or the MACD histogram, right after the candle closes. Each divergence is announced only once. Add *early* to also get signals whose pivot is not fully confirmed yet (labelled early, can fail; off by default). Alias: *!alertdiv*.\n\n*Shortcut:*\n```\n!alertdiv on\n!alertdiv on 4h\n!alertdiv off\n```\n`on` = all coins on 1H/4H/1D, plus your watchlist for 15m (add a timeframe for just that one). `off` = turn off (delete) all your alerts.\n\n*Create alerts one by one:*\n```\n!alertdivergent btc 1h rsi\n!alertdivergent btc 4h\n!alertdivergent all 4h macd\n!alertdivergent watchlist 1d\n!alertdivergent eth 4h bull regular\n```\nNo rsi/macd = both; no bull/bear = both directions; no type = regular + hidden; no timeframe = your default (!tf).\n\n*Manage:*\n```\n!alertdivergent list\n!alertdivergent delete d1\n!alertdivergent delete all\n```\n\n• Regular = potential reversal, Hidden = potential trend continuation.\n• Alerts go to the chat where you created them (you are tagged in groups).\n• Only divergences confirmed AFTER the alert was created; existing ones can be seen with !scandivergent.\n• On every candle close, all new signals are combined in one PDF (grouped by timeframe, Bullish and Bearish). Timeframes that close together go into the same PDF. A few signals are sent as a short text.\n• \"all\" works only for 1H/4H/1D; 15m for all coins is not open yet (too heavy). Use a specific coin or the watchlist.\n• There are limits on alerts per person/chat and messages per hour.\n\n⚠️ Closed candles only. Pivots need 4 confirmation candles, so alerts arrive shortly after the peak/trough. Not a prediction. Educational, not investment advice.",
  "cmd.alerts": "🔔 *!alerts*\n\nShows all your active alerts with their IDs.\n\n*Example:*\n```\n!alerts\n```",
  "cmd.hapusalert": "🗑️ *!deletealert <id>*\n\nDeletes an alert by the ID shown in *!alerts*.\n\n*Example:*\n```\n!deletealert 3\n```",
  "cmd.harian": "🗓️ *!daily [time]*\n\nSubscribe to an automatic daily summary (market + your watchlist), sent to the chat where you run this command. Default time is 08:00 WIB; set it in 24-hour format.\n\n*Example:*\n```\n!daily\n!daily 07:30\n```\n\nStop with *!stopdaily*.",
  "cmd.stopharian": "🗓️ *!stopdaily*\n\nStops the daily summary.\n\n*Example:*\n```\n!stopdaily\n```",

  "cmd.kurs": "💱 *!rate*\n\nShows the current 1 USDT to Rupiah rate.\n\n*Example:*\n```\n!rate\n```",
  "cmd.konversi": "🔄 *!convert <amount> <coin>*\n\nConverts an amount of a coin to USDT and Rupiah.\n\n*Example:*\n```\n!convert 2 SOL\n!convert 0.5 BTC\n```",
  "cmd.tf": "⏱️ *!tf <timeframe>*\n\nSaves your default timeframe, so [tf] in other commands can be left out. Options: 15m, 1H, 4H, 1D (initially 4H).\n\n*Example:*\n```\n!tf 1H\n```",
  "cmd.alertdusdt": "🔔 *!alertdusdt <15m|1H|4H|1D>*\n\nAutomatic alert when USDT Dominance (USDT.D, same as !dusdt) *enters the Fibonacci golden zone* 0.5-0.618. The zone is computed from the Fibonacci swing of closed USDT.D candles on your chosen timeframe (same Fibonacci as in !dusdt and !fib) and compared with the current USDT.D value.\n\n*Examples:*\n```\n!alertdusdt 4h\n!alertdusdt 1d\n```\n\n*Manage:*\n```\n!alertdusdt list\n!alertdusdt delete d1\n!alertdusdt off\n```\n\n• The alert fires when the level *enters* the zone from outside, with a USDT.D chart (golden zone shaded), the current level, the zone bounds and the retracement depth.\n• After firing, it waits for the level to leave the zone (more than 0.03 of retracement depth past the edge) before it can fire again, so a level hovering on the zone edge won't flood the chat.\n• If the Fibonacci swing changes, the zone shifts with it and the status is recalculated without an alert.\n• Conditions that already exist when the alert is created are not announced; you're only told the current position. One alert per timeframe per chat.\n• The alert is sent to the chat where you created it (you're tagged in groups). Checked about every 2 minutes; USDT.D values can differ slightly from TradingView because the data providers differ.\n\n⚠️ Not a prediction. Educational, not investment advice.",
  "cmd.dusdt": "💵 *!dusdt [tf]*\n\nShows USDT Dominance (USDT.D) like a single coin: current value, change over your chosen timeframe, direction (up / down / sideways), plus USDT.D's Higher High / Lower Low structure, Fibonacci levels, and detected patterns (candlestick and swing patterns such as double top/bottom, with confirmation and invalidation levels, same as !pola; all in dominance percent). A pattern chart is also sent when a pattern is detected. tf options: 15m, 1H, 4H, 1D. Empty = your default timeframe (!tf).\n\n*Example:*\n```\n!dusdt\n!dusdt 4h\n!dusdt 1d\n```\n\n_Market information only, not a trading signal or financial advice._",
  "cmd.trenstate": "🧭 *!trenstate <coin> [15m|1H|4H|1D|all]*\n\nAnswers one question: is price *continuing the trend*, in a *healthy pullback*, *at risk of reversing*, or has it *confirmed a reversal*? The result is a conditional label with reasons and an invalidation level, not a prediction.\n\n*Five statuses:*\n🟢 CONTINUING = trend running, no meaningful pullback yet\n🔄 HEALTHY PULLBACK = 23.6-78.6% pullback, structure intact, evidence leans to continuation\n⚠️ REVERSAL WARNING = structure not broken yet but evidence leans toward a reversal\n🔴 REVERSAL CONFIRMED = close broke the last HL/LH swing\n↔️ RANGE / UNCLEAR = structure not aligned\nIf a pullback exists but the evidence is balanced, it shows *PULLBACK, UNCLEAR*.\n\n*Reading the reasons:*\n[+] evidence leaning to continuation\n[!] evidence leaning to reversal\n[-] feature not met\n\n*Example:*\n```\n!trenstate btc\n!trenstate eth 1h\n!trenstate sol all\n```\n\n*Trendline* 📐 (purple lines on the chart): lines through swing supports / resistances. If no valid swing line exists, a regression channel (grey) is used so that in a RANGE or an unclear pullback you still get a rough direction and channel bounds. A broken line against the trend shows up as an early warning before the swing structure breaks. Trendlines are only a reading aid and never change the status.\n\nThree-level grade (strong / medium / weak), no false-precision percentages. Closed candles only. A new status only takes over after holding for 2 candles so it does not flip-flop. Default timeframe *4H* (or whatever you set with !tf). Aliases: !ts, !pullback. Weights and thresholds are still initial heuristics. Educational, not investment advice.",
  "cmd.pola": "🕯️ *!pola <coin|pair> [15m|1H|4H|1D|all] [detail]*\n\nReads *candlestick* patterns on the last few closed candles: engulfing, pin bar (hammer / hanging man / shooting star / inverted hammer), doji, morning/evening star, inside bar, tweezer, harami, piercing / dark cloud, marubozu, three white soldiers / black crows, rising/falling three methods.\n\nPatterns only count at *swing extremes or support/resistance zones*; mid-range ones are ignored. Each pattern is conditional evidence: it has a *confirmation* level (close beyond the pattern's edge) and an *invalidation* level, not a buy/sell order.\n\n*Status:*\nCANDIDATE = just formed\nCONFIRMED = a close already passed the confirmation level\nINVALIDATED is not shown\n\n*How to read the reasons:*\n[+] supporting evidence\n[-] weakening evidence\n\n*Examples:*\n```\n!pola btc\n!pola eth 1h\n!pola sol all\n```\n\n*Forex* (pairs are detected automatically, eurusd / eur/usd both work):\n```\n!pola eurusd\n!pola xauusd 4h\n!pola usdjpy all\n```\nPairs: EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, USDCAD, NZDUSD, EURGBP, EURJPY, GBPJPY, XAUUSD, USDIDR (from 1H). Alias: !fxpola. Chart and text work like crypto, with prices shown at the pair's digits. No volume, so volume evidence is not assessed. Patterns involving an opening gap (after the weekend) get a warning and the gap is marked on the chart. While the market is closed, patterns are read from the last candles before the close. 4H/1D candle boundaries follow UTC and can differ from your broker/TradingView.\n\n*Higher-timeframe priority:*\n⭐ PRIORITY = pattern goes with the trend of the timeframe above it (15m→1H, 1H→4H, 4H→1D)\n⚠️ COUNTER-TREND = pattern goes against the higher-timeframe trend (possibly just a pullback)\n➖ NEUTRAL = the higher timeframe is ranging / unclear\nIf higher-timeframe data fails to load it says \"unavailable\" instead of guessing. This is a label, not a buy/sell order.\n\n*Trend strength (STRONG / MODERATE / WEAK):*\nAnswers \"how strong is the trend right now\" (unlike !trenstate, which answers continue vs reverse). Judged on seven things, each yes / no / cannot assess:\n1. Swings in sequence: highs and lows keep rising (HH+HL) or falling (LL+LH)\n2. Trend line clearly sloped (not shallow)\n3. Neat line: price follows it (high R²)\n4. Recent candles have big bodies in the trend direction with short wicks\n5. The latest retrace (pullback) is shallow\n6. With-trend candles have more volume than against-trend ones\n7. The higher timeframe agrees\n[+] = supports it, [-] = weakens it. Anything that cannot be assessed is not counted; if too little can be assessed the result is capped at WEAK. A ranging market reads \"no clear trend\". No percentages: thresholds are still early heuristics and not backtested.\n\nThree grades (strong / medium / weak), no false-precision percentages. Closed candles only. Default timeframe *4H* (or whatever you set with !tf). Alias: !pattern, !fxpola. Thresholds are still initial heuristics and not backtested. Education, not investment advice.",
  "cmd.alertpola": "🔔 *!alertpola <coin|watchlist> [15m|1H|4H|1D] [up|down] [early|confirmed] [strong]*\n\nAutomatic alert when a NEW candlestick / swing pattern from !pola forms or confirms, judged from closed candles. A pattern is conditional evidence (a confirmation level and an invalidation level), not a buy/sell order.\n\n*Stages:*\n👀 Early = a new CANDIDATE pattern formed, no close beyond the confirmation level yet\n✅ Confirmed = a close broke the confirmation level\nInvalidated patterns are not announced.\n\n*Options:*\nup / down (naik / turun) = bullish / bearish patterns only (without it: both directions, neutral patterns included)\nearly / confirmed (dini / konfirmasi) = that stage only (without it: both)\nstrong (kuat) = strong grade only (confirmed stage only; `dini kuat` is rejected because a CANDIDATE pattern is never strong)\n\n*Examples:*\n```\n!alertpola btc 4h\n!alertpola eth 1h up confirmed\n!alertpola sol 1h early\n!alertpola watchlist 4h confirmed strong\n!alertpola list\n!alertpola delete p1\n!alertpola off\n```\n\nOne specific coin or your watchlist (not all coins at once). Only events after the alert is created are announced, with no duplicates. The alert limit is the same as other alerts. Default timeframe is *4H* (or what you set with !tf). Alias: !alertpattern, !alertfxpola. *Forex*: pairs are recognised automatically (!alertpola eurusd 4h, !alertpola eur/usd 1h up, !alertpola xauusd 4h confirm strong); Yahoo data, no volume, patterns involving an opening gap are flagged, USDIDR from 1H. Watchlist is crypto only. Pattern thresholds are still an early heuristic. Educational, not investment advice.",

  "cmd.fxnews": "📰 *!fxnews [count]*\n📰 *!fxnews on|off|status*\n\nForex news from several sources that back each other up (investingLive/ForexLive, FXStreet, and Finnhub when a key is set). The same story from different sources appears only once.\n\n*Examples:*\n```\n!fxnews\n!fxnews 8\n!fxnews on\n!fxnews on news\n!fxnews on calendar medium\n!fxnews off\n!fxnews status\n```\n• *!fxnews* = latest headlines (default 5, max 10).\n• *!fxnews on* = this chat gets automatic alerts: new headlines + a reminder 15 minutes before important data releases. Options: *news* (headlines only), *calendar* (reminders only), *all* (default), and *medium* to include medium-impact releases (default is high impact only).\n• In groups, only group admins or the owner can switch it on/off.\n• *!fxnews status* = per-source status (OK / failed / cooldown).\n\nAliases: !berita, !fxberita. Headlines are in English, as published by the source.\n\n⚠️ News often lags price action. Not trading advice.",
  "cmd.fxcal": "📅 *!fxcal [today|tomorrow|week] [high|medium|all] [currency]*\n\nEconomic calendar (NFP, CPI, FOMC, interest rates, etc.) from Forex Factory, with Finnhub as backup and saved data if every source fails. Times are shown in WIB.\n\n*Examples:*\n```\n!fxcal\n!fxcal tomorrow\n!fxcal week high\n!fxcal today all usd\n!fxcal week eur gbp\n```\nNo options = today, high and medium impact. Automatic reminders before releases: *!fxnews on*.\n\nAliases: !kalender, !fxkalender. Unofficial data; it can be late or change.\n\n⚠️ Not trading advice.",
};
