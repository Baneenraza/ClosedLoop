package com.loop.app

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(64, 64, 64, 64)
            setBackgroundColor(Color.parseColor("#0f172a"))
        }

        val title = TextView(this).apply {
            text = "🛡️ Loop"
            textSize = 28f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }

        statusText = TextView(this).apply {
            textSize = 16f
            setTextColor(Color.parseColor("#94a3b8"))
            gravity = Gravity.CENTER
            setPadding(0, 32, 0, 48)
        }

        val startBtn = Button(this).apply {
            text = "Start floating shield"
            setOnClickListener { requestOverlayThenStart() }
        }

        val stopBtn = Button(this).apply {
            text = "Stop floating shield"
            setOnClickListener { stopService(Intent(this@MainActivity, BubbleService::class.java)) }
        }

        val serverLabel = TextView(this).apply {
            text = "Server address"
            setTextColor(Color.parseColor("#94a3b8"))
            setPadding(0, 48, 0, 8)
        }

        val serverInput = EditText(this).apply {
            setText(CheckActivity.serverUrl(this@MainActivity))
            setTextColor(Color.WHITE)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isSingleLine = true
        }

        val saveBtn = Button(this).apply {
            text = "Save server address"
            setOnClickListener {
                var url = serverInput.text.toString().trim().trimEnd('/')
                if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
                getSharedPreferences(CheckActivity.PREFS, MODE_PRIVATE).edit()
                    .putString(CheckActivity.PREF_SERVER_URL, url).apply()
                serverInput.setText(url)
                Toast.makeText(this@MainActivity, "Saved", Toast.LENGTH_SHORT).show()
            }
        }

        val openBtn = Button(this).apply {
            text = "Open Loop"
            setOnClickListener { startActivity(Intent(this@MainActivity, CheckActivity::class.java)) }
        }

        root.addView(title)
        root.addView(statusText)
        root.addView(startBtn)
        root.addView(stopBtn)
        root.addView(serverLabel)
        root.addView(serverInput)
        root.addView(saveBtn)
        root.addView(openBtn)
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
        if (Settings.canDrawOverlays(this)) {
            startService(Intent(this, BubbleService::class.java))
        }
    }

    private fun updateStatus() {
        statusText.text = if (Settings.canDrawOverlays(this))
            "Permission granted. The shield bubble is running — drag it anywhere, tap it to check something."
        else
            "Needs permission to draw over other apps. Tap Start."
    }

    private fun requestOverlayThenStart() {
        if (!Settings.canDrawOverlays(this)) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        } else {
            startService(Intent(this, BubbleService::class.java))
        }
    }
}
