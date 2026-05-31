import puppeteer, { Browser, Page } from "puppeteer";
import http from "http";
import https from "https";

export interface ZoomJoinConfig {
  meetingId: string;
  passcode?: string;
  botName: string;
  sessionId: string;
  backendUrl: string;
  headless?: boolean;
}

export interface ZoomSession {
  browser: Browser;
  page: Page;
}

/**
 * Take a screenshot and POST it to the backend.
 */
export async function screenshot(page: Page, name: string, sessionId: string, backendUrl: string) {
  try {
    const buffer = await page.screenshot({ fullPage: true, encoding: "binary" });
    const url = `${backendUrl}/api/sessions/${sessionId}/screenshots`;

    // POST the screenshot as multipart or raw binary
    const body = JSON.stringify({
      name,
      data: (buffer as Buffer).toString("base64"),
    });

    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[screenshot] Upload timed out: ${name}`);
        resolve();
      }, 10000);

      const req = client.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            clearTimeout(timeout);
            resolve();
          });
        }
      );
      req.on("error", (e) => {
        clearTimeout(timeout);
        console.error(`[screenshot] Failed to upload ${name}:`, e.message);
        resolve();
      });
      req.write(body);
      req.end();
    });

    console.log(`[screenshot] Uploaded: ${name}`);
  } catch (e: any) {
    console.error(`[screenshot] Error taking ${name}:`, e.message);
  }
}

/**
 * Wait for any of several selectors, returning whichever matches first.
 */
async function waitForAny(
  page: Page,
  selectors: string[],
  timeout: number = 30000
): Promise<string> {
  const result = await Promise.race(
    selectors.map((sel) =>
      page
        .waitForSelector(sel, { timeout, visible: true })
        .then(() => sel)
        .catch(() => null)
    )
  );
  if (!result) {
    throw new Error(
      `None of the selectors appeared within ${timeout}ms: ${selectors.join(", ")}`
    );
  }
  return result;
}

/**
 * Click a button by its visible text content (case-insensitive partial match).
 */
async function clickButtonByText(
  page: Page,
  text: string,
  timeout: number = 15000
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const clicked = await page.evaluate((searchText: string) => {
      const buttons = Array.from(document.querySelectorAll("button, a, [role='button']"));
      const target = buttons.find((el) =>
        el.textContent?.toLowerCase().includes(searchText.toLowerCase())
      );
      if (target) {
        (target as HTMLElement).click();
        return true;
      }
      return false;
    }, text);
    if (clicked) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Launch a Chromium browser configured for Zoom web client.
 */
async function launchBrowser(headless: boolean): Promise<Browser> {
  return puppeteer.launch({
    headless: headless,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      // Auto-grant mic/camera permissions (prevents permission dialogs)
      "--use-fake-ui-for-media-stream",
      // Provide fake audio/video devices so Zoom sees a mic
      "--use-fake-device-for-media-stream",
      // Allow autoplay without user gesture
      "--autoplay-policy=no-user-gesture-required",
      // Sandbox flags for Docker/CI compatibility
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // Disable GPU (not needed for headless)
      "--disable-gpu",
      // Standard viewport
      "--window-size=1280,720",
      // Disable notifications popup
      "--disable-notifications",
      // Allow insecure content (some Zoom resources)
      "--allow-running-insecure-content",
      // Memory saving flags
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--single-process",
      "--no-zygote",
      // Limit memory
      "--js-flags=--max-old-space-size=256",
    ],
  });
}

/**
 * Normalize a meeting ID by stripping spaces and dashes.
 */
function normalizeMeetingId(meetingId: string): string {
  return meetingId.replace(/[\s-]/g, "");
}

/**
 * Join a Zoom meeting via the web client.
 * Returns the browser + page for further interaction (audio capture).
 */
export async function joinZoomMeeting(
  config: ZoomJoinConfig
): Promise<ZoomSession> {
  const {
    meetingId,
    passcode,
    botName,
    sessionId,
    backendUrl,
    headless = true,
  } = config;

  const normalizedId = normalizeMeetingId(meetingId);
  console.log(`[zoom] Joining meeting ${normalizedId} as "${botName}"`);

  // 1. Launch browser
  const browser = await launchBrowser(headless);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  // Set a realistic user-agent
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  try {
    // 2. Navigate directly to the web client join URL
    const joinUrl = `https://app.zoom.us/wc/join/${normalizedId}`;
    console.log(`[zoom] Navigating to ${joinUrl}`);
    await page.goto(joinUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await screenshot(page, "01-landing", sessionId, backendUrl);

    // 3. Sometimes Zoom shows a "Launch Meeting" page first — look for "Join from Your Browser"
    const joinFromBrowser = await clickButtonByText(
      page,
      "join from your browser",
      5000
    ).catch(() => false);
    if (joinFromBrowser) {
      console.log(`[zoom] Clicked "Join from Your Browser"`);
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
      await screenshot(page, "02-after-browser-join", sessionId, backendUrl);
    }

    // 4. Fill in the display name
    // Zoom uses various selectors for the name input across versions
    const nameSelectors = [
      "#inputname",
      'input[placeholder*="name" i]',
      'input[placeholder*="Name" i]',
      'input[type="text"]',
    ];
    const nameSelector = await waitForAny(page, nameSelectors, 15000);
    console.log(`[zoom] Found name input: ${nameSelector}`);
    await page.click(nameSelector, { clickCount: 3 }); // Select all existing text
    await page.type(nameSelector, botName, { delay: 50 });
    await screenshot(page, "03-name-entered", sessionId, backendUrl);

    // 5. Fill in passcode if required
    const passcodeSelectors = [
      "#inputpasscode",
      'input[placeholder*="passcode" i]',
      'input[placeholder*="password" i]',
      'input[type="password"]',
    ];
    if (passcode) {
      try {
        const passcodeSelector = await waitForAny(page, passcodeSelectors, 5000);
        console.log(`[zoom] Found passcode input: ${passcodeSelector}`);
        await page.type(passcodeSelector, passcode, { delay: 50 });
        await screenshot(page, "04-passcode-entered", sessionId, backendUrl);
      } catch {
        console.log("[zoom] No passcode field found (may not be required)");
      }
    }

    // 6. Click the Join button
    const joinClicked = await clickButtonByText(page, "join", 10000);
    if (!joinClicked) {
      // Fallback: try common join button selectors
      const joinBtnSelectors = [
        "button.btn-join",
        'button[type="submit"]',
        ".join-btn",
        "#joinBtn",
      ];
      const joinBtnSel = await waitForAny(page, joinBtnSelectors, 5000);
      await page.click(joinBtnSel);
    }
    console.log("[zoom] Clicked Join button");
    await screenshot(page, "05-join-clicked", sessionId, backendUrl);

    // 7. Wait for meeting entry — could be instant, or could go through waiting room
    console.log("[zoom] Waiting for meeting entry...");

    const WAIT_TIMEOUT = 10 * 60 * 1000;
    const waitStart = Date.now();
    let lastState = "";
    let waitScreenshot = 0;

    while (Date.now() - waitStart < WAIT_TIMEOUT) {
      const state = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();

        // Check if we're in the meeting (look for meeting UI)
        const meetingIndicators = [
          document.querySelector('[aria-label*="mute" i]'),
          document.querySelector('[aria-label*="leave" i]'),
          document.querySelector('[aria-label*="video" i]'),
          document.querySelector('#wc-footer'),
          document.querySelector('.meeting-app'),
        ].filter(Boolean);
        if (meetingIndicators.length >= 2) return "in_meeting";

        // Check for waiting room
        if (
          text.includes("waiting room") ||
          text.includes("please wait") ||
          text.includes("the host will let you in") ||
          text.includes("wait for the host") ||
          text.includes("meeting host will let you in")
        ) return "waiting_room";

        // Check for errors
        if (
          text.includes("invalid meeting") ||
          text.includes("meeting not found") ||
          text.includes("meeting has expired") ||
          text.includes("unable to join")
        ) return "error";

        // Still loading or transitioning
        return "loading";
      });

      if (state !== lastState) {
        console.log(`[zoom] State: ${state}`);
        lastState = state;
      }

      if (state === "in_meeting") {
        console.log("[zoom] Entered the meeting");
        break;
      }

      if (state === "error") {
        const pageText = await page.evaluate(() => document.body.innerText.slice(0, 300));
        console.error("[zoom] Error detected:", pageText);
        throw new Error("Zoom reported an error joining the meeting");
      }

      // Take a debug screenshot every 10s while waiting
      waitScreenshot++;
      if (waitScreenshot % 5 === 0) {
        await screenshot(page, `06-wait-${waitScreenshot}`, sessionId, backendUrl);
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    if (Date.now() - waitStart >= WAIT_TIMEOUT) {
      throw new Error("Timed out waiting to enter the meeting (10 minutes)");
    }

    await screenshot(page, "07-in-meeting", sessionId, backendUrl);
    console.log("[zoom] Screenshot 07 taken");

    // 8. Handle "Join Audio" dialog — try once, don't block if not found
    console.log("[zoom] Checking for audio join dialog...");
    const audioJoined = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, [role='button'], a"));
      const audioTexts = ["join audio by computer", "join with computer audio", "computer audio", "join audio"];
      for (const btn of buttons) {
        const text = (btn.textContent || "").toLowerCase().trim();
        if (audioTexts.some(t => text.includes(t))) {
          (btn as HTMLElement).click();
          return text;
        }
      }
      return null;
    });
    if (audioJoined) {
      console.log(`[zoom] Clicked audio button: "${audioJoined}"`);
    } else {
      console.log("[zoom] No audio join dialog found — may have auto-joined");
    }
    console.log("[zoom] Screenshot 08 done, attempting mute...");

    // 9. Disable microphone if it's on (we're a listener, not a speaker)
    try {
      const muted = await Promise.race([
        page.evaluate(() => {
          const muteBtn = Array.from(
            document.querySelectorAll("button, [role='button']")
          ).find(
            (el) =>
              el.getAttribute("aria-label")?.toLowerCase().includes("mute") &&
              !el.getAttribute("aria-label")?.toLowerCase().includes("unmute")
          );
          if (muteBtn) {
            (muteBtn as HTMLElement).click();
            return true;
          }
          return false;
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (muted) {
        console.log("[zoom] Muted microphone");
      } else {
        console.log("[zoom] No mute button found or timed out");
      }
    } catch (e: any) {
      console.log(`[zoom] Mute check failed: ${e.message}`);
    }

    // 10. Verify we're actually in the meeting
    console.log("[zoom] Verifying meeting entry...");
    await new Promise((r) => setTimeout(r, 2000));
    const inMeeting = await verifyInMeeting(page);
    await screenshot(page, "09-final-state", sessionId, backendUrl);

    if (!inMeeting) {
      const pageText = await page.evaluate(() => document.body.innerText.slice(0, 500));
      console.error("[zoom] Failed to verify meeting entry. Page text:", pageText);
      await browser.close();
      throw new Error("Could not verify bot is in the meeting. The join may have failed silently.");
    }

    console.log("[zoom] Successfully joined meeting!");
    return { browser, page };
  } catch (error) {
    await screenshot(page, "error-state", sessionId, backendUrl);
    console.error("[zoom] Failed to join meeting:", error);
    await browser.close();
    throw error;
  }
}

/**
 * Verify the bot is actually in the meeting by checking for meeting UI elements.
 */
async function verifyInMeeting(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();

    // Signs we're IN the meeting
    const meetingIndicators = [
      // Toolbar buttons
      () => !!document.querySelector('[aria-label*="mute" i]'),
      () => !!document.querySelector('[aria-label*="audio" i]'),
      () => !!document.querySelector('[aria-label*="video" i]'),
      () => !!document.querySelector('[aria-label*="share" i]'),
      () => !!document.querySelector('[aria-label*="leave" i]'),
      // Meeting footer/toolbar
      () => !!document.querySelector('.meeting-app, .meeting-client, #wc-container-left, #wc-footer'),
      // Participant-related
      () => text.includes("participants"),
    ];

    // Signs we're NOT in the meeting
    const failureIndicators = [
      "invalid meeting id",
      "meeting has expired",
      "this meeting has been ended",
      "meeting not found",
      "unable to join",
      "meeting is not started",
      "check your network",
      "captcha",
    ];

    const hasFailed = failureIndicators.some((s) => text.includes(s));
    if (hasFailed) return false;

    const matchCount = meetingIndicators.filter((fn) => fn()).length;
    return matchCount >= 2;
  });
}

/**
 * Monitor the meeting for end signals.
 * Returns a promise that resolves when the meeting ends.
 */
export async function waitForMeetingEnd(page: Page): Promise<string> {
  console.log("[zoom] Monitoring for meeting end...");

  return new Promise((resolve) => {
    const checkInterval = setInterval(async () => {
      try {
        const meetingEnded = await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return (
            text.includes("this meeting has been ended") ||
            text.includes("the host has ended the meeting") ||
            text.includes("meeting has ended") ||
            text.includes("you have been removed")
          );
        });

        if (meetingEnded) {
          clearInterval(checkInterval);
          resolve("meeting_ended");
        }
      } catch {
        // Page may have been closed/navigated
        clearInterval(checkInterval);
        resolve("page_closed");
      }
    }, 3000);
  });
}
