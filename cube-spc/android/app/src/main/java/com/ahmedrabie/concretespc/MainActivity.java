package com.ahmedrabie.concretespc;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import java.io.OutputStream;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

// Concrete SPC — the analysis page ships inside the APK and runs offline.
// The report is saved as PDF through Android's print screen ("Save as PDF").
public class MainActivity extends Activity {
    private static final int FILE_REQ = 4101;
    private WebView web;
    private ValueCallback<Uri[]> pendingChooser;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFFFFFFFF);
        getWindow().setNavigationBarColor(0xFFFFFFFF);
        getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(0xFFEEF1F0);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingChooser != null) pendingChooser.onReceiveValue(null);
                pendingChooser = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        "application/vnd.ms-excel.sheet.macroEnabled.12",
                        "text/csv", "text/comma-separated-values", "application/octet-stream"});
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose the pouring register"), FILE_REQ);
                } catch (ActivityNotFoundException e) {
                    pendingChooser = null;
                    return false;
                }
                return true;
            }
        });

        web.clearCache(true);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        setContentView(web);
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_REQ || pendingChooser == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) result = new Uri[]{data.getData()};
        pendingChooser.onReceiveValue(result);
        pendingChooser = null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private static final String FOLDER = Environment.DIRECTORY_DOWNLOADS + "/Concrete SPC/";

    private Uri findExisting(ContentResolver cr, String name) {
        Uri coll = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        String sel = MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + "=?";
        try (Cursor c = cr.query(coll, new String[]{MediaStore.MediaColumns._ID}, sel, new String[]{name, FOLDER}, null)) {
            if (c != null && c.moveToFirst()) return Uri.withAppendedPath(coll, String.valueOf(c.getLong(0)));
        } catch (Exception ignored) { }
        return null;
    }

    class Bridge {
        // Saves the Excel report to Download/Concrete SPC and opens it
        @JavascriptInterface
        public String saveFile(String name, String base64, String mime, boolean open) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                ContentResolver cr = getContentResolver();
                Uri uri = findExisting(cr, name);
                if (uri == null) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
                    uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                }
                if (uri == null) throw new IllegalStateException("can't create file");
                try (OutputStream os = cr.openOutputStream(uri, "wt")) {
                    if (os == null) throw new IllegalStateException("can't open file");
                    os.write(bytes);
                }
                final Uri fileUri = uri;
                runOnUiThread(() -> {
                    Toast.makeText(MainActivity.this, "Saved to Download/Concrete SPC: " + name, Toast.LENGTH_LONG).show();
                    if (open) {
                        Intent view = new Intent(Intent.ACTION_VIEW);
                        view.setDataAndType(fileUri, mime);
                        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        try { startActivity(Intent.createChooser(view, "Open the Excel report")); }
                        catch (ActivityNotFoundException e) { Toast.makeText(MainActivity.this, "Install Excel or WPS Office to open it", Toast.LENGTH_LONG).show(); }
                    }
                });
                return uri.toString();
            } catch (Exception e) {
                final String m = e.getMessage();
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Save failed: " + m, Toast.LENGTH_LONG).show());
                return "";
            }
        }

        @JavascriptInterface
        public void printPdf(final String name) {
            runOnUiThread(() -> {
                try {
                    PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                    PrintDocumentAdapter adapter = web.createPrintDocumentAdapter(name);
                    PrintAttributes attrs = new PrintAttributes.Builder()
                            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                            .build();
                    pm.print(name, adapter, attrs);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Could not open the print screen: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}
