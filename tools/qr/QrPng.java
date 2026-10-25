import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;

import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import javax.imageio.ImageIO;

/**
 * 把标准输入的一行文本渲染成二维码 PNG：`java QrPng <out.png> [scale]`。
 * 文本走 stdin（不走 argv）——配对链接里带 token，不该出现在 `ps` 里。
 * 用仓库自带的 zxing-core 编码，零新增依赖，也不把 token 发给任何在线服务。
 */
public final class QrPng {
    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: QrPng <out.png> [scale]");
            System.exit(2);
        }
        String text = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine();
        if (text == null || text.trim().isEmpty()) {
            System.err.println("empty input");
            System.exit(3);
        }
        int scale = args.length > 1 ? Integer.parseInt(args[1]) : 8;
        Map<EncodeHintType, Object> hints = new HashMap<>();
        hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
        hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
        hints.put(EncodeHintType.MARGIN, 2);
        BitMatrix m = new QRCodeWriter().encode(text.trim(), BarcodeFormat.QR_CODE, 0, 0, hints);
        int w = m.getWidth(), h = m.getHeight();
        BufferedImage img = new BufferedImage(w * scale, h * scale, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int rgb = m.get(x, y) ? 0x000000 : 0xFFFFFF;
                for (int dy = 0; dy < scale; dy++) {
                    for (int dx = 0; dx < scale; dx++) img.setRGB(x * scale + dx, y * scale + dy, rgb);
                }
            }
        }
        File out = new File(args[0]);
        ImageIO.write(img, "png", out);
        System.out.println("ok " + w + "x" + h + " scale=" + scale + " bytes=" + out.length());
    }
}
