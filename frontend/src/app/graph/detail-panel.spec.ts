import { TestBed } from "@angular/core/testing";
import { provideAnimationsAsync } from "@angular/platform-browser/animations/async";
import { ComponentFixture } from "@angular/core/testing";
import { vi } from "vitest";
import { DetailPanelComponent, SelectedNodeData } from "./detail-panel";

describe("DetailPanelComponent", () => {
  const sampleNode: SelectedNodeData = {
    id: "screen_dashboard",
    label: "Dashboard",
    path: "/dashboard",
    componentFile: "app/dashboard/page.tsx",
    description: "Dashboard overview",
    variants: [
      {
        id: "v1",
        label: "Loading state",
        condition: "Data is being fetched",
        type: "loading",
      },
      {
        id: "v2",
        label: "Empty state",
        condition: "No items found",
        type: "empty",
      },
    ],
    outgoingTransitions: [
      {
        id: "t1",
        from: "screen_dashboard",
        to: "screen_settings",
        trigger: "Click settings",
        method: "router.push",
        condition: "User is admin",
      },
    ],
  };

  let fixture: ComponentFixture<DetailPanelComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [DetailPanelComponent],
      providers: [provideAnimationsAsync()],
    });

    fixture = TestBed.createComponent(DetailPanelComponent);
    fixture.componentRef.setInput("node", sampleNode);
    fixture.detectChanges();
  });

  it("should create the component", () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  it("should display the node label", () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const title = compiled.querySelector("mat-card-title");
    expect(title?.textContent).toContain("Dashboard");
  });

  it("should display the node path", () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const subtitle = compiled.querySelector("mat-card-subtitle");
    expect(subtitle?.textContent).toContain("/dashboard");
  });

  it("should display the component file path", () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const filePath = compiled.querySelector(".file-path");
    expect(filePath?.textContent).toContain("app/dashboard/page.tsx");
  });

  it("should display variant count", () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const sectionLabels = compiled.querySelectorAll(".section-label");
    const variantSection = Array.from(sectionLabels).find((el) =>
      el.textContent?.includes("Variants"),
    );
    expect(variantSection?.textContent).toContain("2");
  });

  it("should display outgoing transitions count", () => {
    const compiled = fixture.nativeElement as HTMLElement;
    const sectionLabels = compiled.querySelectorAll(".section-label");
    const transSection = Array.from(sectionLabels).find((el) =>
      el.textContent?.includes("Outgoing transitions"),
    );
    expect(transSection?.textContent).toContain("1");
  });

  it("should emit closed event when close button is clicked", () => {
    const closedSpy = vi.fn();
    fixture.componentInstance.closed.subscribe(closedSpy);

    fixture.componentInstance.close();
    expect(closedSpy).toHaveBeenCalled();
  });

  it("should return correct variant type labels", () => {
    const component = fixture.componentInstance;
    expect(component.variantTypeLabel("loading")).toBe("Loading");
    expect(component.variantTypeLabel("error")).toBe("Error");
    expect(component.variantTypeLabel("empty")).toBe("Empty");
    expect(component.variantTypeLabel("auth_required")).toBe("Auth");
    expect(component.variantTypeLabel("permission")).toBe("Permission");
    expect(component.variantTypeLabel("responsive")).toBe("Responsive");
    expect(component.variantTypeLabel("conditional")).toBe("Conditional");
    expect(component.variantTypeLabel("unknown_type")).toBe("unknown_type");
  });

  it("should return correct variant type icons", () => {
    const component = fixture.componentInstance;
    expect(component.variantTypeIcon("loading")).toBe("hourglass_empty");
    expect(component.variantTypeIcon("error")).toBe("error_outline");
    expect(component.variantTypeIcon("unknown_type")).toBe("label");
  });
});
