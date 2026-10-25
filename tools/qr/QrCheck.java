import com.google.zxing.*;
import com.google.zxing.common.HybridBinarizer;
import javax.imageio.ImageIO;
import java.io.File;
import java.awt.image.BufferedImage;
public class QrCheck {
  public static void main(String[] a) throws Exception {
    BufferedImage img = ImageIO.read(new File(a[0]));
    int w = img.getWidth(), h = img.getHeight();
    int[] px = new int[w * h];
    img.getRGB(0, 0, w, h, px, 0, w);
    BinaryBitmap bmp = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(w, h, px)));
    Result r = new MultiFormatReader().decode(bmp);
    String t = r.getText();
    System.out.println("decoded len=" + t.length() + " -> " + t.replaceAll("k=[^&]+", "k=<hidden>"));
  }
}
