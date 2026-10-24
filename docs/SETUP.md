# Set up and use Swing Desk Agent (step by step)

This guide is for a Windows computer. You will run the app and Claude on the **same computer**.
No coding is needed. Copy each command exactly as shown.

**What the app does:** Claude looks up stocks and suggests trades. The app checks every
suggestion against your rules. **You** decide. The app never buys or sells by itself. You always
place orders yourself in the Kite app.

**Cost:** the app is free. Claude uses your existing Claude plan.

---

## Part 1 – Install (one time only)

### Step 1. Install Node.js

Node.js is the free program that runs the app.

1. Go to <https://nodejs.org>.
2. Download the version that starts with **24** and install it. Click *Next* on every screen.
3. Check it worked. Open **Command Prompt** (press the Windows key, type `cmd`, press Enter) and type:

   ```
   node --version
   ```

   You should see something like `v24.10.0`. If it starts with `v24`, you are good.

### Step 2. Get the app

**Easy way (no Git):**

1. Open <https://github.com/saranshthedev/swing-desk-agent>.
2. Click the green **Code** button → **Download ZIP**.
3. Right-click the downloaded ZIP → **Extract All**. Put it in your **Documents** folder.
4. Rename the folder to `swing-desk-agent` if it has a different name.

**If you use Git:**

```
cd %USERPROFILE%\Documents
git clone https://github.com/saranshthedev/swing-desk-agent.git
```

There is nothing else to install. The app has no extra packages.

### Step 3. Install Claude Code

The app talks to **Claude Code**. The easiest way to get it:

1. Install **VS Code** from <https://code.visualstudio.com> (free).
2. Open VS Code → click the **Extensions** icon on the left → search **Claude Code** → **Install**.
3. Sign in with your Claude account when it asks.

---

## Part 2 – First start (one time only)

### Step 4. Open the app folder in VS Code

1. In VS Code: **File → Open Folder…** → choose the `swing-desk-agent` folder.
2. Open a terminal inside VS Code: **Terminal → New Terminal**. A panel opens at the bottom.

### Step 5. Start the app

In the terminal, type:

```
npm start
```

You will see:

```
Swing Desk Agent is running: http://127.0.0.1:8790
```

Now open **<http://127.0.0.1:8790>** in Chrome or Edge. You will see the **Today** page.

> **Keep this terminal open.** If you close it, the app stops. To stop the app on purpose,
> click in the terminal and press **Ctrl + C**.

### Step 6. Connect Claude to the app

Open a **second** terminal: click the **+** button in the terminal panel. Type:

```
npm run connect
```

It asks you a few questions:

1. **New PIN** – make up a number of 6 to 12 digits. Type it twice. The letters do not show
   while you type; that is normal.
   - This PIN is like an ATM PIN. You need it to approve trades.
   - **Never tell your PIN to Claude or any AI.** Write it somewhere safe.
2. **What may Claude do?** Type one word and press Enter:
   - `read` – Claude can only look. It cannot add anything.
   - `draft` – Claude can also save research and prices it finds. **Start with this.**
   - `propose` – Claude can also send you trade ideas to approve. Choose this later, when you trust it.

When you see **Done**, Claude is connected.

> Want to change `draft` to `propose` later? Run `npm run connect` again, choose `propose`,
> and type `y` when it asks to replace the old connection.

### Step 7. Check that Claude can see the app

1. Open the Claude Code panel in VS Code and start a **new conversation**.
2. Type `/mcp` and press Enter. You should see **swing-desk** with a green tick ✔.
3. Ask Claude:

   > Use swing-desk: call whoami and list_strategies.

   Claude should tell you its access level and list three strategies.

### Step 8. Set your money rules

In the browser, open **Settings**. Fill in your own numbers. Example for ₹1,00,000 capital:

| Setting | Example | What it means |
|---|---|---|
| Trading capital | 100000 | The money you use for trading. |
| Max loss per trade | 0.5 | You lose at most 0.5% of capital (₹500) if the price hits your stop. |
| Max own cash per trade | 25000 | You put at most ₹25,000 of your own money into one trade. |
| Minimum reward ÷ risk | 2 | The possible gain must be at least 2 times the possible loss. |
| Max open lots | 6 | At most 6 open buys at the same time. |
| Max total loss if every stop is hit | 3 | If every open trade hit its stop together, you would lose at most 3% (₹3,000). |
| Max MTF borrowing | 100 | You borrow at most 100% of capital (₹1,00,000) from Zerodha. |
| Pause new buys after this week’s loss | 3 | If you lose 3% (₹3,000) this week, new buys stop until Monday. |
| Worse-price allowance | 0.1 | Expect to buy slightly higher and sell slightly lower than planned. |

Type your PIN at the bottom and click **Save limits**.

> **Borrowed money is not extra safety money.** With 2× leverage a ₹50,000 trade uses ₹25,000
> of your cash and ₹25,000 borrowed. If the price falls 5%, you still lose ₹2,500 (plus interest).

### Step 9. Look at the checklist and strategies

Open **Checklist**. It lists everything worth checking before a trade: market direction, global
markets, USDINR, crude oil and other commodities, the economy, sector, company fundamentals, event
dates, weekly and monthly demand and supply zones, the daily chart, volume, your plan, money and the
order itself. Each check says why it matters and where to look for free.

Checks come in **two stages**:

1. **Research** – done on the Prepare page days before you buy; it counts only inside the strategy’s window (default: from 3 to 5 days after you prepare it).
2. **Just before buying** – must be checked on the day.

Open **Strategies**. Each strategy uses a set of these checks:

- **You answer** – you tick yes yourself when you approve.
- **Evidence** – a record must back it, for example a news check from today. Records Claude
  saves count only after you **verify** them.

Each strategy also has a **research window**: **buffer days** (at least 3) is how long a prepared
research item must wait before it counts, **expire days** (at most 21) is how long it keeps
counting. Example: buffer 3, expire 5: research ticked on Monday counts Thursday to Saturday.
Every strategy needs at least one required research item.
- **Rule** – the app checks this by itself, for example "stop at most 8% below entry".

The built-in strategies are **examples**, not advice. **Complete pre-trade checklist** has every
check (core ones required, the rest optional). You can edit any strategy, or click
**Make my own strategy from this list** on the Checklist page and remove what you do not need.

---

## Part 3 – Every trading day

### Step 10. Start the app

Open VS Code → the `swing-desk-agent` folder → **Terminal → New Terminal** → `npm start`.
Open <http://127.0.0.1:8790>.

### Step 10b. Prepare a stock a few days ahead (stage 1, required)

Nothing can be approved until its research has been prepared **and has waited**.

1. Open **Prepare**. Type the stock, keep the exchange on **NSE** (or pick BSE), click
   **Show checklist**. Price and chart items count only on the exchange you prepare.
2. Copy the ready-made request at the bottom into Claude Code. Claude reads the records you
   already verified, researches what is missing, and saves what it finds with sources
   (market-wide checks once under **MARKET**). It can also save its own wait/buy/hold/sell view.
3. Go through the **Master list**. For a “you answer” item, click **I checked this**. For an
   evidence item, click **Verify** on Claude’s record if it is right, then **Use this verified
   record**, or **Add a record** yourself (its good-until date is filled in for you).
4. Below, each strategy shows its window, what is still missing and the first day its research
   all counts. Last come two views side by side: **Desk rules** and **Claude (written by a model ·
   not verified)**. If they differ it says “The desk and Claude disagree”. Neither is advice.

The TradingView chart on Prepare shows BSE prices only; nothing on it counts for NSE.

### Step 11. Ask Claude to research

In Claude Code, ask in plain words. Examples:

> Use swing-desk. Look at TATAMOTORS for the breakout strategy. Check today's news, the daily
> chart and the next results date. Save each thing you find with add_evidence and include sources.
> Then tell me if it fits the checklist.

> Use swing-desk. Check today's news for all my open lots and save it as evidence.

What Claude saves appears on **Today** under **New from Claude**, on the stock’s page and on
Prepare, marked *found, not verified*, with a **Verify** button. Once verified, a record is reused
until its good-until date, so Claude does not search for it again. If a record is wrong, open the
stock and click **Correct**: the old record stays in the history, marked corrected.

### Step 12. Get a trade idea checked

- If Claude has **propose** access, ask it to send a buy request:
  > If it fits, use calculate_plan and then propose_buy with the breakout strategy.
- Or make one yourself: **New plan** in the browser. Fill in the stock, entry, stop, target and
  days. Choose **Leverage (×)** or **Own cash %** for MTF, whichever your broker shows.
  Click **Preview size and charges**, then **Send to Requests**.

The app works out **how many shares** fit your rules and **all Zerodha charges**. It does not trust
Claude's numbers.

### Step 13. Approve or reject

Open **Requests** → click the request. You see:

- **The plan in plain words** – your cash, borrowed money, loss at stop and gain at target.
- **Checks** – green *Pass*, orange *Needs update*, red *Fail*, blue *Your answer*.

Fix anything orange:

1. **Fresh price** – open Kite and look at the price. If Claude found the same price, click
   **"Kite shows ₹… now: confirm"**. Or type Kite's price yourself. A price counts for **5 minutes**.
2. **MTF requirement** – in Kite, check the stock's MTF leverage for today. Confirm Claude's value
   or type it in as leverage or own cash %.
3. **Claude’s on-the-day records** – click **Verify** next to each one that is right (news,
   daily chart, whole-market checks).
4. **Your answers** – the checklist shows **1. Research** (read-only: “Prepared on …”, from the
   Prepare page) and **2. Just before buying**. Tick each on-the-day item only if it is really
   true today.

Type your PIN → **Approve**. Or write a reason → **Reject**.

### Step 14. Place the order in Kite yourself

After approval you get an **order ticket**, for example:

```
BUY 22 SAMPLE on NSE · MTF 2× (50% own cash) · LIMIT ₹500.00 · then set stop ₹485.00 and target ₹560.00
```

Open Kite and place exactly that order. The app does **not** place orders.

### Step 15. Record what really happened

When Kite shows the order is filled:

1. Open the request again → **Record your buy**.
2. Enter the **actual price** from Kite (the average price, if it filled at several prices) and the date.
3. Click **Save buy**. It now shows under **Positions**.

When you sell:

1. **Positions** → the stock → **Record a sale**.
2. Enter shares sold, the actual price and the date.
3. If you have the **contract note**, type the total charges. If not, leave it blank and the
   app will estimate them.

Selling only part? Enter fewer shares. The rest stays open at the same buy price.

### Step 16. End of day

- Look at **Today** for your risk, open lots and this week's result.
- To stop the app: click its terminal and press **Ctrl + C**.

---

## Part 4 – Automatic work (optional)

You can let Claude do jobs at set times, for example a news check every morning.

### Step 17. Make a playbook

1. In the browser: **Playbooks → New playbook**.
2. Give it a name, choose **Run by: Claude Code**, choose days and time (India time).
3. Write instructions in plain words. Example:
   > For each open lot, check today's news and save it with add_evidence (kind news) with links.
   > Finish with complete_task and a 3-line summary.
4. Type your PIN → **Save playbook**.

> The app only gives Claude the job at that time **if `npm start` is running**.

### Step 18. Make Claude check in at that time

Windows **Task Scheduler** can start Claude a few minutes after the playbook time.

1. Run `npm run connect` once and note the line **"Found Claude Code: …claude.exe"**. That is
   the program path. (It changes when VS Code updates the extension; check it again after updates.)
2. Make an empty folder, for example `C:\SwingDeskRuns`.
3. Press the Windows key, type **Task Scheduler**, open it → **Create Basic Task…**
   - **Name:** Swing Desk morning check
   - **Trigger:** Weekly → tick Monday to Friday → time a few minutes after your playbook time.
   - **Action:** Start a program.
     - **Program:** the `claude.exe` path from step 1.
     - **Arguments:**

       ```
       -p "Call the swing-desk next_task tool. If it returns a task, follow its instructions exactly and finish with complete_task. If it returns null, stop." --allowedTools "mcp__swing-desk__*" "WebSearch" "WebFetch"
       ```

     - **Start in:** `C:\SwingDeskRuns`
4. Finish. Your computer must be on and you must be logged in at that time.

Results show under **Playbooks → Recent tasks**. Any trade ideas wait in **Requests** for you.

The `--allowedTools` part keeps Claude to the app and web search only during automatic runs.

> There is no market-holiday list. Turn playbooks **off** on market holidays.

---

## Part 5 – Stay safe

- **Stop Claude at once:** click **Pause all agents** (left side, on every page). To start again,
  go to **Settings** and enter your PIN.
- **Remove Claude's access:** **Agents & MCP** → **Change** → tick **Revoke this key** → PIN → Save.
- **Never share your PIN** with Claude or anyone.
- **Back up:** **Settings → Back up now**. Do it every week. The backup is saved in your data folder (below).
- Claude Code in VS Code can also read files on your computer. That means it could get around
  the app's limits. Only use Claude Code you trust. Automatic runs use `--allowedTools` to block this.

**Where your data is kept:** `C:\Users\<your name>\AppData\Local\SwingDeskAgent`
(paste `%LOCALAPPDATA%\SwingDeskAgent` into File Explorer). It stays on your computer only.

---

## Part 6 – Problems and fixes

| Problem | Fix |
|---|---|
| `node` is not recognized | Install Node.js 24 (step 1), then close and reopen VS Code. |
| `npm start` says the port is in use | The app is already running in another terminal. Use that one, or close it with Ctrl + C. |
| Browser says "This site can't be reached" | The app is not running. Do step 10. |
| `/mcp` does not show swing-desk | Start a new Claude conversation or reload VS Code. Still missing? Run `npm run connect` again. |
| `npm run connect` says Claude Code not found | Install the Claude Code extension (step 3). It then prints a command; run that command. |
| Claude says "paused" | Go to **Settings** and resume agents with your PIN. |
| Claude says "key has expired" | Keys last 90 days. Run `npm run connect` again. |
| "Wrong PIN" | Check your PIN. After 5 wrong tries, wait 15 minutes. |
| Approve says "Not ready" | Read the orange and red checks. Usually you need a fresh price (5 minutes) or to tick your answers. |
| Ledger says "Chain broken" | Your data was changed outside the app. Restore your last backup. |

---

## Part 7 – Get a newer version

- **Downloaded ZIP:** download the new ZIP and replace the old app folder. Your data is safe;
  it is kept in a different folder.
- **Used Git:** in the app folder run `git pull`.

Then start the app again with `npm start`.
