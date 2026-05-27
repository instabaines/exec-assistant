export function HelpGuide() {
  return (
    <div className="help-shell">

      <div className="help-section">
        <h2>First-time setup</h2>

        <h3>Writing engine</h3>
        <p>Evo uses <strong>Ollama</strong> (free, local) to generate emails and power the AI assistant. Install it from <code>ollama.com</code>, then pull a model:</p>
        <pre className="help-code">ollama pull mistral</pre>
        <p>Open <strong>Settings</strong> — the status bar should say <em>"Writing engine connected"</em>. Select your model from the dropdown.</p>

        <h3>Email delivery</h3>
        <p>Go to <strong>Settings → Email delivery</strong>. For Gmail:</p>
        <div className="help-table-wrap">
          <table className="help-table">
            <tbody>
              <tr><td>SMTP host</td><td><code>smtp.gmail.com</code></td></tr>
              <tr><td>Port</td><td><code>587</code></td></tr>
              <tr><td>Username</td><td>your Gmail address</td></tr>
              <tr><td>Password</td><td>App Password (16-character code)</td></tr>
            </tbody>
          </table>
        </div>
        <div className="help-callout">
          <strong>Getting a Gmail App Password:</strong> myaccount.google.com → Security → <em>How you sign in to Google</em> → <em>2-Step Verification</em> → scroll to the bottom → <em>App passwords</em>. Only appears when 2-Step Verification is already on.
        </div>
      </div>

      <div className="help-section">
        <h2>Outreach — 3-step flow</h2>

        <h3>Step 1 · Contacts</h3>
        <p>Drag in a CSV or Excel file and map the columns, or use the <strong>Quick add</strong> form to add a single lead. Click any contact name to open their <strong>360 profile</strong> — every email, deal, task, and meeting mention in one place.</p>

        <h3>Step 2 · Create a round</h3>
        <p>Write what the message should accomplish in the <em>Instructions</em> field. The agent reads that brief plus your contacts' details and generates a personalised email for each person.</p>
        <div className="help-callout">
          <strong>Tip:</strong> Click <em>Manage knowledge docs</em> before generating to attach a campaign brief or company profile. The AI draws facts directly from these documents.
        </div>
        <p><strong>Agent pipeline</strong> — a two-step planner → writer mode. Slower but produces better structure for complex briefs.</p>

        <h3>Step 3 · Review &amp; Send</h3>
        <div className="help-table-wrap">
          <table className="help-table">
            <tbody>
              <tr><td><strong>Approve all</strong></td><td>One-click bulk approval after a quick scan</td></tr>
              <tr><td><strong>Apply rewrite request</strong></td><td>Fill in the instruction field, click this — AI rewrites using your instruction <em>and</em> the original brief</td></tr>
              <tr><td><strong>Regenerate</strong></td><td>Fresh draft from scratch, still on-brief</td></tr>
              <tr><td><strong>Open in mail app</strong></td><td>Sends to your default email client</td></tr>
            </tbody>
          </table>
        </div>
        <p className="help-shortcuts"><strong>Keyboard shortcuts:</strong> <kbd>j</kbd> next draft · <kbd>k</kbd> previous · <kbd>a</kbd> approve</p>
      </div>

      <div className="help-section">
        <h2>AI features</h2>

        <h3>Morning briefing</h3>
        <p>The home screen generates a short paragraph covering what needs attention — pending approvals, overdue tasks, stale deals, recent meetings. Click <strong>Refresh</strong> to regenerate.</p>

        <h3>AI Assistant</h3>
        <p>Ask anything about your workspace in plain language. The assistant reads your live tasks, deals, meetings, outreach, contacts, and knowledge docs. Try:</p>
        <ul className="help-examples">
          <li>"Which deals haven't moved this week?"</li>
          <li>"What tasks are overdue?"</li>
          <li>"Summarise my last three meetings."</li>
          <li>"Draft a follow-up for my most stale deal."</li>
        </ul>
        <p><kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> new line · <strong>Clear</strong> to reset</p>

        <h3>Knowledge base</h3>
        <div className="help-table-wrap">
          <table className="help-table">
            <thead><tr><th>Type</th><th>When it's injected</th></tr></thead>
            <tbody>
              <tr><td>Company profile</td><td>Every AI generation</td></tr>
              <tr><td>Campaign brief</td><td>Emails for that specific round</td></tr>
              <tr><td>Contact note</td><td>Emails to that specific recipient</td></tr>
            </tbody>
          </table>
        </div>
        <div className="help-callout">
          Adding a company profile is the single biggest improvement to email quality. Do it before your first round.
        </div>
      </div>

      <div className="help-section">
        <h2>Pipeline, Tasks &amp; Meetings</h2>

        <h3>Deals</h3>
        <p>Four active stages: Lead → Qualified → Proposal → Negotiation, plus Won/Lost. Move deals by changing the stage dropdown. Deals idle for <strong>7+ days</strong> show a red badge — a prompt to take action.</p>

        <h3>Tasks</h3>
        <p>Create manually or push from meeting action items. Overdue tasks are highlighted in amber. Filter by status with the tabs at the top.</p>

        <h3>Meetings</h3>
        <p>Paste raw notes → <strong>AI Summarize</strong> → the model writes a clean summary and extracts action items. Each action item has an <strong>Add as task</strong> button.</p>

        <h3>Writing rules</h3>
        <p>Settings → <strong>Rule library</strong>. Each rule is a named template tied to an industry. The agent picks the best match per recipient automatically. Type an industry and click <strong>Generate rule with AI</strong> to create a new one from scratch.</p>
      </div>

      <div className="help-section">
        <h2>Tips</h2>
        <ul className="help-tips">
          <li><strong>Brief quality = email quality.</strong> The more specific your campaign instructions, the better the output. Describe the offer, audience, and desired outcome concretely.</li>
          <li><strong>Company profile first.</strong> Add one to the knowledge base before running your first round — it's the biggest lever on output quality.</li>
          <li><strong>360 view before a follow-up.</strong> Click a contact's name to see every email already sent to them, their deal status, and related tasks before drafting a follow-up.</li>
          <li><strong>Rewrite requests.</strong> Be specific: "shorten to 3 sentences and remove the second paragraph" works better than "make it better".</li>
          <li><strong>Red deal badges.</strong> If you see more than two or three stale deals at once, that's a pipeline health problem worth addressing today — not tomorrow.</li>
        </ul>
      </div>

    </div>
  );
}
