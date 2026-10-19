package com.loop.app

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView

class CheckActivity : Activity() {
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var webView: WebView
    private lateinit var connectingText: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val loadTimeout = Runnable { showServerError("timed out") }
    private var lastUrl = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(true)
        webView = WebView(this)
        webView.settings.javaScriptEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        // localStorage keeps the anonymous device ID used for community reports.
        webView.settings.domStorageEnabled = true
        webView.setBackgroundColor(Color.parseColor("#0f172a"))
        connectingText = TextView(this).apply {
            text = "🛡️ Connecting to Loop…\n\nThe first check after a quiet spell can take up to a minute while the server wakes up."
            textSize = 16f
            setTextColor(Color.parseColor("#e2e8f0"))
            setBackgroundColor(Color.parseColor("#0f172a"))
            gravity = Gravity.CENTER
            setPadding(64, 64, 64, 64)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                // Unreachable hosts otherwise hang for minutes on the OS connect timeout;
                // the limit still leaves room for a Render free instance to cold-start.
                handler.removeCallbacks(loadTimeout)
                if (url?.startsWith("http") == true) {
                    connectingText.visibility = View.VISIBLE
                    handler.postDelayed(loadTimeout, LOAD_TIMEOUT_MS)
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                handler.removeCallbacks(loadTimeout)
                connectingText.visibility = View.GONE
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                super.onReceivedError(view, request, error)
                Log.e("Loop", "WebView load error: ${error?.description} for ${request?.url}")
                if (request?.isForMainFrame == true) showServerError(error?.description?.toString() ?: "load failed")
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val acceptTypes = params?.acceptTypes?.filter { it.isNotBlank() } ?: emptyList()
                val mimeType = acceptTypes.firstOrNull() ?: "*/*"
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = mimeType
                }
                startActivityForResult(Intent.createChooser(intent, "Select file"), FILE_CHOOSER_REQUEST)
                return true
            }
        }
        webView.addJavascriptInterface(BrowserBridge(), "Android")
        setContentView(FrameLayout(this).apply {
            addView(webView)
            addView(connectingText, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            // Android 15 draws apps edge-to-edge; keep the page clear of the status and navigation bars.
            setBackgroundColor(Color.parseColor("#0f172a"))
            setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        })
        // A trusted link opened fresh never needs the dashboard; just hand it to the browser.
        if (!loadForIntent(intent)) finish()
    }

    private inner class BrowserBridge {
        @JavascriptInterface
        fun openInBrowser(url: String) {
            runOnUiThread { openExternally(url) }
        }

        @JavascriptInterface
        fun share(text: String) {
            runOnUiThread {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, text)
                }
                startActivity(Intent.createChooser(send, null))
            }
        }
    }

    private fun openExternally(url: String) {
        val chromeIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            setPackage("com.android.chrome")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(chromeIntent)
        } catch (e: Exception) {
            // Chrome isn't installed — fall back to any other browser, explicitly excluding ourselves
            // (we're the default handler, so an unqualified VIEW intent would just loop back to us).
            val plain = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val chooser = Intent.createChooser(plain, "Open with").apply {
                putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(this@CheckActivity, CheckActivity::class.java)))
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(chooser)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        loadForIntent(intent)
    }

    // Returns false when the link was trusted and sent straight to the browser (nothing loaded here).
    private fun loadForIntent(intent: Intent): Boolean {
        val viewedUri = if (intent.action == Intent.ACTION_VIEW) intent.data else null
        if (viewedUri != null && isTrusted(viewedUri)) {
            openExternally(viewedUri.toString())
            return false
        }
        val mode = intent.getStringExtra(EXTRA_MODE)
        val server = serverUrl(this)
        val url = when {
            viewedUri != null -> "$server/?check=" + Uri.encode(viewedUri.toString())
            mode == "verify" -> "$server/?verify=1"
            else -> server
        }
        lastUrl = url
        webView.loadUrl(url)
        return true
    }

    // Checked on the phone so everyday links open instantly and never reach the server.
    private fun isTrusted(uri: Uri): Boolean {
        val host = uri.host?.lowercase()?.removePrefix("www.") ?: return false
        // An embedded URL (e.g. google.com/url?q=https://...) is a redirect; let the server check where it goes.
        if (uri.query?.contains("http", ignoreCase = true) == true) return false
        return host in TRUSTED_HOSTS || TRUSTED_DOMAINS.any { host == it || host.endsWith(".$it") }
    }

    private fun showServerError(reason: String) {
        handler.removeCallbacks(loadTimeout)
        webView.stopLoading()
        val server = TextUtils.htmlEncode(serverUrl(this))
        val retry = TextUtils.htmlEncode(lastUrl)
        val html = """
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:24px">
            <h2>🛡️ Can't reach the Loop server</h2>
            <p>Tried <b>$server</b> (${TextUtils.htmlEncode(reason)}).</p>
            <p>Make sure the server is running and this phone is on the same Wi-Fi, then set the right
            address in the Loop app's home screen.</p>
            <p><a style="color:#38bdf8;font-size:18px" href="$retry">Try again</a></p>
            </body></html>
        """.trimIndent()
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    override fun onDestroy() {
        handler.removeCallbacks(loadTimeout)
        super.onDestroy()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            val uri = if (resultCode == RESULT_OK) data?.data else null
            filePathCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
            filePathCallback = null
        } else {
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    companion object {
        // Default only; the real value is set from MainActivity and stored in prefs.
        const val DEFAULT_SERVER_URL = "https://loop-2chr.onrender.com"
        const val FILE_CHOOSER_REQUEST = 51426
        const val EXTRA_MODE = "mode"
        const val PREFS = "loop"
        const val PREF_SERVER_URL = "server_url"
        const val LOAD_TIMEOUT_MS = 75_000L

        // Keep in sync with TRUSTED_HOSTS / TRUSTED_DOMAINS in link-check.js (the server copy).
        // Exact hosts only: sibling subdomains like sites.google.com or docs.google.com host
        // user content (a common phishing trick), so they still go through the full check.
        val TRUSTED_HOSTS = setOf(
            "google.com", "google.com.pk", "youtube.com", "m.youtube.com", "youtu.be",
            "facebook.com", "m.facebook.com", "instagram.com", "x.com", "twitter.com", "linkedin.com",
            "daraz.pk", "dawn.com", "geo.tv", "bbc.com", "bbc.co.uk",
        )

        // Any subdomain is fine: banks, government sites and Wikipedia language editions don't host phishing pages.
        val TRUSTED_DOMAINS = setOf(
            "wikipedia.org", "hbl.com", "meezanbank.com", "ubl.com.pk", "mcb.com.pk", "bankalfalah.com",
            "jazzcash.com.pk", "easypaisa.com.pk", "bisp.gov.pk", "nadra.gov.pk", "sbp.org.pk",
        )

        fun serverUrl(context: Context): String =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(PREF_SERVER_URL, null)?.takeIf { it.isNotBlank() }?.trimEnd('/')
                ?: DEFAULT_SERVER_URL
    }
}
