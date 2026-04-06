import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { MatToolbarModule } from "@angular/material/toolbar";
import { MatCardModule } from "@angular/material/card";

@Component({
  selector: "app-root",
  imports: [RouterOutlet, MatToolbarModule, MatCardModule],
  templateUrl: "./app.html",
  styleUrl: "./app.scss",
})
export class App {
  protected readonly title = "Route Atlas";
}
