import { Component, inject, OnInit } from "@angular/core";
import { Router, RouterOutlet } from "@angular/router";
import { MatToolbarModule } from "@angular/material/toolbar";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatMenuModule } from "@angular/material/menu";
import { AuthService } from "./auth/auth.service";

@Component({
  selector: "app-root",
  imports: [
    RouterOutlet,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
  ],
  templateUrl: "./app.html",
  styleUrl: "./app.scss",
})
export class App implements OnInit {
  authService = inject(AuthService);
  private router = inject(Router);

  ngOnInit() {
    this.authService.checkAuth().subscribe();
  }

  onLogout() {
    this.authService.logout().subscribe(() => {
      this.router.navigate(["/login"]);
    });
  }
}
