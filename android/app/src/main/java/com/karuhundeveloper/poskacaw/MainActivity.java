package com.karuhundeveloper.poskacaw;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Preview getUserMedia di WebView perlu hardware acceleration. Beberapa
        // ROM mematikannya untuk activity yang memakai tema splash.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
        // Daftarin plugin lokal (printer thermal BT/USB) sebelum bridge dibuat.
        registerPlugin(ThermalPrinterPlugin.class);
        registerPlugin(SecureCredentialPlugin.class);
        registerPlugin(NativeBarcodeScannerPlugin.class);
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setBackgroundColor(android.graphics.Color.TRANSPARENT);
    }
}
