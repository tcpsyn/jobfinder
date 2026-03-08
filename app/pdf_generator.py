import io
import fitz


def _wrap_text(text: str, font: str, fontsize: float, max_width: float) -> list[str]:
    """Word-wrap text to fit within max_width pixels."""
    lines = []
    for paragraph in text.split("\n"):
        if not paragraph.strip():
            lines.append("")
            continue
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            test = f"{current} {word}"
            tw = fitz.get_text_length(test, fontname=font, fontsize=fontsize)
            if tw <= max_width:
                current = test
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def generate_resume_pdf(resume_text: str, name: str = "") -> bytes:
    """Generate a clean resume PDF from plain text."""
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)  # Letter size

    margin_x = 54
    margin_top = 54
    max_width = 612 - 2 * margin_x
    y = margin_top

    body_font = "helv"
    body_size = 10.5
    heading_size = 12
    line_height = body_size * 1.5
    heading_line_height = heading_size * 1.8

    for raw_line in resume_text.split("\n"):
        line = raw_line.strip()

        # Detect section headings (all caps lines or lines ending with colon)
        is_heading = (
            (line == line.upper() and len(line) > 2 and line.replace(" ", "").isalpha())
            or (line.endswith(":") and len(line) < 60 and not line.startswith("-"))
        )

        if is_heading:
            y += 6  # extra space before heading
            if y > 740:
                page = doc.new_page(width=612, height=792)
                y = margin_top

            page.insert_text(
                fitz.Point(margin_x, y),
                line,
                fontname=body_font,
                fontsize=heading_size,
                color=(0.1, 0.1, 0.1),
            )
            # Underline
            tw = fitz.get_text_length(line, fontname=body_font, fontsize=heading_size)
            page.draw_line(
                fitz.Point(margin_x, y + 3),
                fitz.Point(margin_x + min(tw, max_width), y + 3),
                color=(0.7, 0.7, 0.7),
                width=0.5,
            )
            y += heading_line_height
            continue

        if not line:
            y += line_height * 0.5
            continue

        # Word-wrap body text
        wrapped = _wrap_text(line, body_font, body_size, max_width)
        for wl in wrapped:
            if y > 750:
                page = doc.new_page(width=612, height=792)
                y = margin_top
            page.insert_text(
                fitz.Point(margin_x, y),
                wl,
                fontname=body_font,
                fontsize=body_size,
                color=(0.15, 0.15, 0.15),
            )
            y += line_height

    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


def generate_cover_letter_pdf(cover_letter: str, company: str = "",
                               position: str = "") -> bytes:
    """Generate a cover letter PDF."""
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)

    margin_x = 72
    max_width = 612 - 2 * margin_x
    y = 72

    body_font = "helv"
    body_size = 11
    line_height = body_size * 1.6

    # Title
    title = "Cover Letter"
    if position and company:
        title = f"Cover Letter — {position} at {company}"
    elif position:
        title = f"Cover Letter — {position}"

    page.insert_text(
        fitz.Point(margin_x, y),
        title,
        fontname=body_font,
        fontsize=13,
        color=(0.1, 0.1, 0.1),
    )
    y += 30

    # Separator line
    page.draw_line(
        fitz.Point(margin_x, y - 8),
        fitz.Point(612 - margin_x, y - 8),
        color=(0.8, 0.8, 0.8),
        width=0.5,
    )

    # Body
    for raw_line in cover_letter.split("\n"):
        line = raw_line.strip()
        if not line:
            y += line_height * 0.6
            continue

        wrapped = _wrap_text(line, body_font, body_size, max_width)
        for wl in wrapped:
            if y > 740:
                page = doc.new_page(width=612, height=792)
                y = 72
            page.insert_text(
                fitz.Point(margin_x, y),
                wl,
                fontname=body_font,
                fontsize=body_size,
                color=(0.15, 0.15, 0.15),
            )
            y += line_height

    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()
