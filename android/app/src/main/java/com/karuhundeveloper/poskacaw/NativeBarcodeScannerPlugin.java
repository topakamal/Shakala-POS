package com.karuhundeveloper.poskacaw;

import android.Manifest;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "NativeBarcodeScanner",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class NativeBarcodeScannerPlugin extends Plugin {
    private PreviewView previewView;
    private ProcessCameraProvider cameraProvider;
    private Camera camera;
    private BarcodeScanner barcodeScanner;
    private ExecutorService analyzerExecutor;

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        startScanner(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Izin kamera ditolak.", "permission_denied");
            return;
        }
        startScanner(call);
    }

    private void startScanner(PluginCall call) {
        getActivity().runOnUiThread(() -> startScannerOnMain(call));
    }

    private void startScannerOnMain(PluginCall call) {
        if (previewView != null) {
            resolveStarted(call);
            return;
        }

        int left = call.getInt("left", 0);
        int top = call.getInt("top", 0);
        int width = call.getInt("width", 1);
        int height = call.getInt("height", 1);
        View webView = getBridge().getWebView();
        if (!(webView.getParent() instanceof ViewGroup)) {
            call.reject("Container preview kamera tidak tersedia.", "camera_view_unavailable");
            return;
        }
        ViewGroup host = (ViewGroup) webView.getParent();

        previewView = new PreviewView(getContext());
        previewView.setImplementationMode(PreviewView.ImplementationMode.PERFORMANCE);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        previewView.setBackgroundColor(Color.BLACK);
        previewView.setX(left);
        previewView.setY(top);
        host.addView(previewView, 0, new ViewGroup.LayoutParams(width, height));

        BarcodeScannerOptions options = new BarcodeScannerOptions.Builder()
            .setBarcodeFormats(
                Barcode.FORMAT_EAN_13,
                Barcode.FORMAT_EAN_8,
                Barcode.FORMAT_UPC_A,
                Barcode.FORMAT_UPC_E,
                Barcode.FORMAT_CODE_128,
                Barcode.FORMAT_CODE_39,
                Barcode.FORMAT_ITF,
                Barcode.FORMAT_CODABAR,
                Barcode.FORMAT_QR_CODE
            )
            .build();
        barcodeScanner = BarcodeScanning.getClient(options);
        analyzerExecutor = Executors.newSingleThreadExecutor();

        ListenableFuture<ProcessCameraProvider> providerFuture =
            ProcessCameraProvider.getInstance(getContext());
        providerFuture.addListener(() -> {
            try {
                cameraProvider = providerFuture.get();
                Preview preview = new Preview.Builder().build();
                ImageAnalysis analysis = new ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build();
                analysis.setAnalyzer(analyzerExecutor, this::analyze);
                CameraSelector selector = CameraSelector.DEFAULT_BACK_CAMERA;
                cameraProvider.unbindAll();
                camera = cameraProvider.bindToLifecycle(
                    getActivity(), selector, preview, analysis);
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                resolveStarted(call);
            } catch (Exception error) {
                cleanupCamera();
                call.reject("Kamera native gagal dinyalakan: " + error.getMessage(), "camera_start_failed");
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }

    private void resolveStarted(PluginCall call) {
        JSObject result = new JSObject();
        result.put("torchAvailable", camera != null && camera.getCameraInfo().hasFlashUnit());
        call.resolve(result);
    }

    private void analyze(@NonNull ImageProxy imageProxy) {
        if (barcodeScanner == null || imageProxy.getImage() == null) {
            imageProxy.close();
            return;
        }
        InputImage image = InputImage.fromMediaImage(
            imageProxy.getImage(), imageProxy.getImageInfo().getRotationDegrees());
        barcodeScanner.process(image)
            .addOnSuccessListener(barcodes -> {
                for (Barcode barcode : barcodes) {
                    String value = barcode.getRawValue();
                    if (value == null || value.isEmpty()) continue;
                    JSObject result = new JSObject();
                    result.put("value", value);
                    result.put("format", formatName(barcode.getFormat()));
                    notifyListeners("barcodeScanned", result);
                    break;
                }
            })
            .addOnCompleteListener(task -> imageProxy.close());
    }

    private String formatName(int format) {
        switch (format) {
            case Barcode.FORMAT_EAN_13: return "ean_13";
            case Barcode.FORMAT_EAN_8: return "ean_8";
            case Barcode.FORMAT_UPC_A: return "upc_a";
            case Barcode.FORMAT_UPC_E: return "upc_e";
            case Barcode.FORMAT_CODE_128: return "code_128";
            case Barcode.FORMAT_CODE_39: return "code_39";
            case Barcode.FORMAT_ITF: return "itf";
            case Barcode.FORMAT_CODABAR: return "codabar";
            case Barcode.FORMAT_QR_CODE: return "qr_code";
            default: return "unknown";
        }
    }

    @PluginMethod
    public void setTorch(PluginCall call) {
        getActivity().runOnUiThread(() -> setTorchOnMain(call));
    }

    private void setTorchOnMain(PluginCall call) {
        if (camera == null) {
            call.reject("Kamera belum aktif.", "camera_not_started");
            return;
        }
        ListenableFuture<Void> torchFuture = camera.getCameraControl()
            .enableTorch(call.getBoolean("enabled", false));
        torchFuture.addListener(() -> {
            try {
                torchFuture.get();
                call.resolve();
            } catch (Exception error) {
                call.reject("Senter tidak tersedia.", "torch_failed");
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            cleanupCamera();
            call.resolve();
        });
    }

    private void cleanupCamera() {
        if (cameraProvider != null) cameraProvider.unbindAll();
        camera = null;
        if (barcodeScanner != null) barcodeScanner.close();
        barcodeScanner = null;
        if (analyzerExecutor != null) analyzerExecutor.shutdownNow();
        analyzerExecutor = null;
        if (previewView != null) {
            ViewGroup parent = (ViewGroup) previewView.getParent();
            if (parent != null) parent.removeView(previewView);
            previewView = null;
        }
        cameraProvider = null;
    }
}
